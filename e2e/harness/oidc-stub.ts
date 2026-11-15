// A small OpenID Connect provider for SSO tests, modelled on the mock in
// app/tests/modules/sso/login.rs. It listens on a free loopback port, which
// Dopbase accepts over plain http, and signs ES256 ID tokens.
//
// /authorize signs in whoever the test chose with `nextUser()` straight
// away and redirects back with a code; there is no login page.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type OidcUser = {
  /** Stable subject; defaults to one derived from the lowercased email. */
  subject?: string;
  email: string;
  /** Omit to leave the claim out. */
  emailVerified?: boolean;
  /** Seconds since the user signed in at the provider, sent as auth_time. */
  authAge?: number;
};

type Grant = { user: OidcUser; nonce?: string; clientId: string };

export class OidcStub {
  readonly clientId = "dopbase-e2e";
  readonly clientSecret = `secret-${randomBytes(12).toString("hex")}`;
  url = "";
  /** Token requests seen, for tests that check PKCE and client auth. */
  readonly tokenRequests: { authorization: string; codeVerifier: string }[] =
    [];
  private readonly privateKey: KeyObject;
  private readonly jwk: Record<string, string>;
  private readonly grants = new Map<string, Grant>();
  private next: OidcUser = { email: "root@dopbase.com", emailVerified: true };
  private server?: Server;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    this.privateKey = privateKey;
    const { x, y } = publicKey.export({ format: "jwk" }) as {
      x: string;
      y: string;
    };
    this.jwk = {
      kty: "EC",
      crv: "P-256",
      kid: "k1",
      use: "sig",
      alg: "ES256",
      x,
      y,
    };
  }

  /** The issuer URL to enter in Dopbase's SSO settings. */
  get issuer(): string {
    return this.url;
  }

  /** Who the next /authorize request signs in as. */
  nextUser(user: OidcUser): void {
    this.next = user;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((done) =>
      this.server!.listen(0, "127.0.0.1", done),
    );
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((done) => this.server!.close(() => done()));
    this.server = undefined;
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    if (url.pathname === "/.well-known/openid-configuration") {
      return this.send(res, 200, {
        issuer: this.url,
        authorization_endpoint: `${this.url}/authorize`,
        token_endpoint: `${this.url}/token`,
        jwks_uri: `${this.url}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks")
      return this.send(res, 200, { keys: [this.jwk] });
    if (url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri");
      if (!redirect) return this.send(res, 400, { error: "invalid_request" });
      const code = `code_${randomBytes(12).toString("hex")}`;
      this.grants.set(code, {
        user: this.next,
        nonce: url.searchParams.get("nonce") ?? undefined,
        clientId: url.searchParams.get("client_id") ?? this.clientId,
      });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state) back.searchParams.set("state", state);
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      this.tokenRequests.push({
        authorization: req.headers.authorization ?? "",
        codeVerifier: form.get("code_verifier") ?? "",
      });
      const code = form.get("code") ?? "";
      const grant = this.grants.get(code);
      this.grants.delete(code);
      if (!grant) return this.send(res, 400, { error: "invalid_grant" });
      return this.send(res, 200, {
        access_token: `access_${randomBytes(8).toString("hex")}`,
        token_type: "Bearer",
        expires_in: 300,
        id_token: this.idToken(grant),
      });
    }
    this.send(res, 404, { error: "not_found" });
  }

  private idToken(grant: Grant): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.url,
      aud: grant.clientId,
      // A real provider's subject never changes with the email's case, and
      // two people never share one: hash the whole lowercased address.
      sub:
        grant.user.subject ??
        `sub-${createHash("sha256").update(grant.user.email.toLowerCase()).digest("hex").slice(0, 24)}`,
      email: grant.user.email,
      iat: now,
      exp: now + 300,
    };
    if (grant.nonce) claims.nonce = grant.nonce;
    if (grant.user.emailVerified !== undefined)
      claims.email_verified = grant.user.emailVerified;
    if (grant.user.authAge !== undefined)
      claims.auth_time = now - grant.user.authAge;
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode({ alg: "ES256", typ: "JWT", kid: "k1" })}.${encode(claims)}`;
    const signature = sign("sha256", new TextEncoder().encode(input), {
      key: this.privateKey,
      dsaEncoding: "ieee-p1363",
    });
    return `${input}.${signature.toString("base64url")}`;
  }
}
