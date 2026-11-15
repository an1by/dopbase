// Single sign-on against the fake OIDC provider in harness/oidc-stub.ts.
// The browser leg (start → provider /authorize → callback) runs in a
// request context that does not follow redirects and keeps cookies, the
// way a browser would carry the dopbase_sso binding cookie.
import { request, type APIRequestContext } from "@playwright/test";
import { ApiClient } from "../harness/api.ts";
import {
  about,
  expect,
  ROOT,
  step,
  test,
  useServer,
  type Account,
} from "../harness/index.ts";
import {
  ALL_FEATURES,
  expectError,
  expectOk,
  freshSession,
  QUIET,
} from "./support.ts";

const app = useServer({ env: ALL_FEATURES, sso: true });
const PROVIDER_NAME = "Acme SSO";

/** A cookie-keeping client that stops at every redirect. */
class Browser {
  csrf = "";
  private constructor(
    readonly context: APIRequestContext,
    readonly api: ApiClient,
  ) {}

  static async open(): Promise<Browser> {
    const context = await request.newContext({
      baseURL: app.url,
      maxRedirects: 0,
    });
    return new Browser(context, new ApiClient("browser", context, []));
  }

  /** Signs in with a password; the session cookie stays in the context. */
  async login(account: Account): Promise<void> {
    const login = await this.api.send(
      "POST",
      "/auth/login",
      {
        email: account.email,
        password: account.password,
        sessionKind: "browser",
      },
      QUIET,
    );
    expect(login.ok, JSON.stringify(login.body)).toBe(true);
    this.csrf = login.data.csrfToken;
  }

  /** A write with this session's CSRF header. */
  post(path: string, body?: unknown, record = true) {
    return this.api.send("POST", path, body ?? {}, {
      headers: { "x-dopbase-csrf": this.csrf },
      record,
    });
  }

  /**
   * Opens a provider authorize URL (the stub signs in whoever nextUser()
   * named) and follows its redirect to Dopbase's callback. Returns where
   * the callback sends the browser next.
   */
  async throughProvider(authorizeUrl: string): Promise<string> {
    const authorize = await this.context.get(authorizeUrl);
    expect(authorize.status(), await authorize.text()).toBe(302);
    const callback = new URL(authorize.headers()["location"]!);
    expect(callback.pathname).toBe("/api/v1/auth/sso/callback");
    const result = await this.api.get(`${callback.pathname}${callback.search}`);
    expect(result.status).toBe(302);
    return result.headers["location"]!;
  }

  /** GET /auth/sso/start, then the provider. Returns the callback's redirect. */
  async startLogin(): Promise<string> {
    const start = await this.api.get("/auth/sso/start?redirect=/projects");
    expect(start.status).toBe(302);
    const location = start.headers["location"]!;
    if (!location.startsWith(app.oidc!.issuer)) return location;
    const authorize = new URL(location);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("client_id")).toBe(app.oidc!.clientId);
    return this.throughProvider(location);
  }

  /** Trades the handoff in `/login/sso#code=…` for a session. */
  async exchange(location: string) {
    const code = location.match(/^\/login\/sso#code=(.+)$/)?.[1];
    expect(code, `not a handoff location: ${location}`).toBeTruthy();
    return this.api.post("/auth/sso/exchange", { code });
  }

  async close(): Promise<void> {
    await this.context.dispose();
  }
}

/** The provider settings body for the stub. */
function providerBody() {
  return {
    preset: "generic",
    displayName: PROVIDER_NAME,
    issuer: app.oidc!.issuer,
    clientId: app.oidc!.clientId,
    clientSecret: app.oidc!.clientSecret,
  };
}

/**
 * Makes sure the stub is configured, verified by root's test sign-in, and
 * enabled, with nothing required or hidden. Quiet: setup for later tests.
 */
async function ensureSso(): Promise<void> {
  const settings = await app.api.must("GET", "/sso/provider", undefined, QUIET);
  if (!settings.provider) {
    await app.api.must("PUT", "/sso/provider", providerBody(), QUIET);
  }
  const current = await app.api.must("GET", "/sso/provider", undefined, QUIET);
  if (!current.provider.verifiedAt) {
    const browser = await Browser.open();
    await browser.login(ROOT);
    app.oidc!.nextUser({ email: ROOT.email, emailVerified: true });
    const link = await browser.post("/auth/sso/link", {}, false);
    expect(link.ok, JSON.stringify(link.body)).toBe(true);
    await browser.throughProvider(link.data.authorizeUrl);
    await browser.close();
  }
  if (!current.provider.enabled) {
    await app.api.must(
      "PUT",
      "/sso/provider/enabled",
      { enabled: true },
      QUIET,
    );
  }
  await app.api.must(
    "PUT",
    "/sso/provider/required",
    { required: false },
    QUIET,
  );
  await app.api.must(
    "PUT",
    "/sso/provider/password-form",
    { hidden: false },
    QUIET,
  );
}

test(
  "configure the provider and enable it",
  {
    tag: "@sso",
    annotation: about(
      "Root saves the stub as an OIDC provider, can't enable it before a test sign-in, links itself through the provider to verify it, and then enables it; the login page starts offering it.",
    ),
  },
  async () => {
    await step(
      "GET /sso/provider before any setup has no provider",
      async () => {
        const settings = expectOk(await app.api.get("/sso/provider"));
        expect(settings.provider).toBeNull();
      },
    );
    await step(
      "GET /auth/sso/start while SSO is off goes back to login",
      async () => {
        const browser = await Browser.open();
        const start = await browser.api.get("/auth/sso/start");
        expect(start.status).toBe(302);
        expect(start.headers["location"]).toBe("/login?sso_error=disabled");
        await browser.close();
      },
    );
    await step(
      "PUT /sso/provider with an unreachable issuer is 422",
      async () => {
        const result = await app.api.put("/sso/provider", {
          ...providerBody(),
          issuer: "http://127.0.0.1:1",
        });
        expect(result.status).toBe(422);
      },
    );
    await step(
      "PUT /sso/provider saves the stub, not yet enabled",
      async () => {
        const saved = expectOk(
          await app.api.put("/sso/provider", providerBody()),
        );
        expect(saved.provider).toMatchObject({
          displayName: PROVIDER_NAME,
          issuer: app.oidc!.issuer,
          clientId: app.oidc!.clientId,
          enabled: false,
          verifiedAt: null,
        });
        expect(JSON.stringify(saved)).not.toContain(app.oidc!.clientSecret);
        expect(saved.redirectUri).toBe(`${app.url}/api/v1/auth/sso/callback`);
      },
    );
    await step(
      "PUT /sso/provider/enabled before a test sign-in is 409",
      async () => {
        expectError(
          await app.api.put("/sso/provider/enabled", { enabled: true }),
          409,
          "SSO_NOT_VERIFIED",
        );
      },
    );
    await step(
      "Root's test sign-in: POST /auth/sso/link through the provider",
      async () => {
        const browser = await Browser.open();
        await browser.login(ROOT);
        app.oidc!.nextUser({ email: ROOT.email, emailVerified: true });
        const link = expectOk(await browser.post("/auth/sso/link"));
        expect(link.authorizeUrl.startsWith(app.oidc!.issuer)).toBe(true);
        expect(await browser.throughProvider(link.authorizeUrl)).toBe(
          "/sso?linked=1",
        );
        await browser.close();
        const token = app.oidc!.tokenRequests.at(-1)!;
        expect(token.authorization).toBe(
          `Basic ${Buffer.from(`${app.oidc!.clientId}:${app.oidc!.clientSecret}`).toString("base64")}`,
        );
        expect(token.codeVerifier.length).toBeGreaterThanOrEqual(43);
      },
    );
    await step("PUT /sso/provider/enabled", async () => {
      const enabled = expectOk(
        await app.api.put("/sso/provider/enabled", { enabled: true }),
      );
      expect(enabled.provider).toMatchObject({
        enabled: true,
        linkedAccounts: 1,
      });
      expect(enabled.provider.verifiedAt).toBeTruthy();
    });
    await step("GET /auth/methods offers the provider", async () => {
      const methods = expectOk(
        await (await app.anonymousApi()).get("/auth/methods"),
      );
      expect(methods.sso).toMatchObject({ name: PROVIDER_NAME });
    });
    await step(
      "SSO settings without a session are refused, and an Admin gets 403",
      async () => {
        expect(
          (await (await app.anonymousApi()).get("/sso/provider")).status,
        ).toBe(401);
        const admin = await app.apiAs(await app.make.user({ role: "Admin" }));
        expect((await admin.get("/sso/provider")).status).toBe(403);
        expect((await admin.put("/sso/provider", providerBody())).status).toBe(
          403,
        );
      },
    );
  },
);

test(
  "start, callback and exchange sign a person in",
  {
    tag: "@sso",
    annotation: about(
      "A person with a verified email at the provider signs in through start, the provider, the callback and the exchange, and gets a browser session; the handoff code works once.",
    ),
  },
  async () => {
    await ensureSso();
    const user = await app.make.user();
    const browser = await Browser.open();
    app.oidc!.nextUser({
      email: user.email.toUpperCase(),
      emailVerified: true,
    });
    const handoff = await step(
      "GET /auth/sso/start, the provider, then GET /auth/sso/callback",
      async () => {
        const location = await browser.startLogin();
        expect(location).toMatch(/^\/login\/sso#code=/);
        return location;
      },
    );
    await step(
      "POST /auth/sso/exchange returns a browser session",
      async () => {
        const exchanged = expectOk(await browser.exchange(handoff));
        expect(exchanged.session).toMatchObject({
          email: user.email,
          sessionKind: "browser",
        });
        expect(exchanged.session.csrfToken).toMatch(/^csrf_/);
        expect(exchanged.redirectTo).toBe("/projects");
      },
    );
    await step("The session cookie works for GET /auth/session", async () => {
      expect(expectOk(await browser.api.get("/auth/session")).email).toBe(
        user.email,
      );
    });
    await step("The same handoff again is 401", async () => {
      expectError(await browser.exchange(handoff), 401, "SSO_HANDOFF_INVALID");
    });
    await step("A handoff from another browser is 401", async () => {
      const other = await Browser.open();
      app.oidc!.nextUser({ email: user.email, emailVerified: true });
      const location = await browser.startLogin();
      expectError(await other.exchange(location), 401, "SSO_HANDOFF_INVALID");
      await other.close();
    });
    await step("The sign-in is audited with method sso", async () => {
      const events = await app.api.must(
        "GET",
        `/audit-events?action=login.succeeded&actor=${user.id}`,
        undefined,
        QUIET,
      );
      expect(
        events.items.some(
          (e: { metadata: { method?: string } }) => e.metadata.method === "sso",
        ),
      ).toBe(true);
    });
    await browser.close();
  },
);

test(
  "link an identity and reauthenticate through SSO",
  {
    tag: "@sso",
    annotation: about(
      "A signed-in person links the provider to their account, confirms themselves again through it, unlinks it, and root can remove another person's link.",
    ),
  },
  async () => {
    await ensureSso();
    const user = await app.make.user();
    const browser = await Browser.open();
    await browser.login(user);
    await step("GET /auth/sso/identity: available, not linked", async () => {
      const identity = expectOk(await browser.api.get("/auth/sso/identity"));
      expect(identity).toMatchObject({
        available: true,
        linked: false,
        providerName: PROVIDER_NAME,
      });
    });
    await step("POST /auth/sso/reauth before linking is 409", async () => {
      expectError(
        await browser.post("/auth/sso/reauth"),
        409,
        "SSO_NOT_LINKED",
      );
    });
    await step(
      "POST /auth/sso/link and come back through the provider",
      async () => {
        // The provider knows them by another address; the link is by session.
        app.oidc!.nextUser({
          email: `work-${user.email}`,
          emailVerified: true,
        });
        const link = expectOk(await browser.post("/auth/sso/link"));
        expect(await browser.throughProvider(link.authorizeUrl)).toBe(
          "/account?sso=linked",
        );
      },
    );
    await step("GET /auth/sso/identity shows the link", async () => {
      const identity = expectOk(await browser.api.get("/auth/sso/identity"));
      expect(identity).toMatchObject({
        linked: true,
        emailAtLink: `work-${user.email}`,
      });
    });
    await step(
      "The linked subject now signs in, whatever its email",
      async () => {
        const other = await Browser.open();
        app.oidc!.nextUser({
          email: `work-${user.email}`,
          emailVerified: false,
        });
        const exchanged = expectOk(
          await other.exchange(await other.startLogin()),
        );
        expect(exchanged.session.email).toBe(user.email);
        await other.close();
      },
    );
    await step(
      "POST /auth/sso/reauth confirms through the provider",
      async () => {
        app.oidc!.nextUser({
          email: `work-${user.email}`,
          emailVerified: true,
          authAge: 0,
        });
        const reauth = expectOk(await browser.post("/auth/sso/reauth"));
        expect(await browser.throughProvider(reauth.authorizeUrl)).toBe(
          "/sso/confirmed",
        );
        expect(
          expectOk(await browser.api.get("/auth/session")).recentAuthentication,
        ).toBe(true);
      },
    );
    await step("DELETE /auth/sso/identity unlinks it", async () => {
      expectOk(
        await browser.api.send("DELETE", "/auth/sso/identity", undefined, {
          headers: { "x-dopbase-csrf": browser.csrf },
        }),
      );
      expect(expectOk(await browser.api.get("/auth/sso/identity")).linked).toBe(
        false,
      );
    });
    await step("DELETE /auth/sso/identity again is 404", async () => {
      expectError(
        await browser.api.send("DELETE", "/auth/sso/identity", undefined, {
          headers: { "x-dopbase-csrf": browser.csrf },
        }),
        404,
        "SSO_NOT_LINKED",
      );
    });
    await browser.close();

    const linked = await app.make.user();
    const theirs = await Browser.open();
    await theirs.login(linked);
    app.oidc!.nextUser({ email: linked.email, emailVerified: true });
    await theirs.throughProvider(
      (await theirs.post("/auth/sso/link", {}, false)).data.authorizeUrl,
    );
    await theirs.close();
    await step(
      "DELETE /users/{id}/sso: root removes someone else's link",
      async () => {
        expectOk(await app.api.delete(`/users/${linked.id}/sso`));
        const user = await app.api.must(
          "GET",
          `/users/${linked.id}`,
          undefined,
          QUIET,
        );
        expect(user.ssoLinked).toBe(false);
      },
    );
    await step("DELETE /users/{id}/sso again is 404", async () => {
      expectError(
        await app.api.delete(`/users/${linked.id}/sso`),
        404,
        "SSO_NOT_LINKED",
      );
    });
    await step("A Member can't remove someone's link (403)", async () => {
      const member = await app.apiAs(await app.make.user());
      expect((await member.delete(`/users/${linked.id}/sso`)).status).toBe(403);
    });
  },
);

test(
  "SSO required blocks password login, and the password form can be hidden",
  {
    tag: "@sso",
    annotation: about(
      "With SSO required, a person's password login is refused while root's still works; hiding the password form shows in /auth/methods; both switch back off.",
    ),
  },
  async () => {
    await ensureSso();
    const user = await app.make.user();
    await step("PUT /sso/provider/required true", async () => {
      expect(
        expectOk(
          await app.api.put("/sso/provider/required", { required: true }),
        ).provider.requireSso,
      ).toBe(true);
    });
    await step("A person's password login is refused", async () => {
      const fresh = await ApiClient.create(app.url, "fresh", []);
      const login = await fresh.post("/auth/login", {
        email: user.email,
        password: user.password,
        sessionKind: "browser",
      });
      expect(login.status).toBe(403);
      expect(Object.keys(login.body.error)).toContain(
        "PASSWORD_LOGIN_DISABLED",
      );
      await fresh.dispose();
    });
    await step(
      "Root, the break-glass account, still signs in with a password",
      async () => {
        const root = await freshSession(app, ROOT);
        await root.dispose();
      },
    );
    await step("The person signs in with SSO instead", async () => {
      const browser = await Browser.open();
      app.oidc!.nextUser({ email: user.email, emailVerified: true });
      expect(
        expectOk(await browser.exchange(await browser.startLogin())).session
          .email,
      ).toBe(user.email);
      await browser.close();
    });
    await step("PUT /sso/provider/password-form hidden", async () => {
      expectOk(
        await app.api.put("/sso/provider/password-form", { hidden: true }),
      );
      const methods = expectOk(
        await (await app.anonymousApi()).get("/auth/methods"),
      );
      expect(methods.passwordForm).toBe(false);
    });
    await step(
      "PUT /sso/provider/required false and the form back",
      async () => {
        expectOk(
          await app.api.put("/sso/provider/required", { required: false }),
        );
        expectOk(
          await app.api.put("/sso/provider/password-form", { hidden: false }),
        );
        expect(
          expectOk(await (await app.anonymousApi()).get("/auth/methods"))
            .passwordForm,
        ).toBe(true);
        await (await freshSession(app, user)).dispose();
      },
    );
  },
);

test(
  "unverified or unknown emails are refused with a clear error",
  {
    tag: "@sso",
    annotation: about(
      "The callback sends the browser back to the login page with a reason when the provider's email is unverified, belongs to nobody, belongs to a disabled account, or is root's unlinked address; a made-up handoff is 401.",
    ),
  },
  async () => {
    await ensureSso();
    const user = await app.make.user();
    const disabled = await app.make.user();
    await app.api.must("POST", `/users/${disabled.id}/disable`, {}, QUIET);
    const cases: [
      string,
      { email: string; emailVerified?: boolean },
      string,
    ][] = [
      [
        "an unverified email",
        { email: user.email, emailVerified: false },
        "email_unverified",
      ],
      ["no email_verified claim", { email: user.email }, "email_unverified"],
      [
        "an email nobody has",
        { email: "stranger@dopbase.com", emailVerified: true },
        "account_not_found",
      ],
      [
        "a disabled account's email",
        { email: disabled.email, emailVerified: true },
        "account_disabled",
      ],
    ];
    for (const [label, who, reason] of cases) {
      await step(
        `Callback with ${label} → /login?sso_error=${reason}`,
        async () => {
          const browser = await Browser.open();
          app.oidc!.nextUser({ subject: app.uniq("sub"), ...who });
          expect(await browser.startLogin()).toBe(`/login?sso_error=${reason}`);
          await browser.close();
        },
      );
    }
    await step(
      "A provider error on the callback goes back to login",
      async () => {
        const browser = await Browser.open();
        const result = await browser.api.get(
          "/auth/sso/callback?error=access_denied&state=nope",
        );
        expect(result.status).toBe(302);
        expect(result.headers["location"]).toMatch(/^\/login\?sso_error=/);
        await browser.close();
      },
    );
    await step(
      "POST /auth/sso/exchange with a made-up code is 401",
      async () => {
        const browser = await Browser.open();
        expectError(
          await browser.api.post("/auth/sso/exchange", { code: "made-up" }),
          401,
          "SSO_HANDOFF_INVALID",
        );
        await browser.close();
      },
    );
  },
);

test(
  "deleting the provider turns SSO off",
  {
    tag: "@sso",
    annotation: about(
      "DELETE /sso/provider removes the settings: the login page stops offering SSO and a start goes back to login; deleting again is 404.",
    ),
  },
  async () => {
    await ensureSso();
    await step("DELETE /sso/provider", async () => {
      expectOk(await app.api.delete("/sso/provider"));
    });
    await step("GET /auth/methods no longer offers SSO", async () => {
      expect(
        expectOk(await (await app.anonymousApi()).get("/auth/methods")).sso,
      ).toBeNull();
    });
    await step("GET /auth/sso/start goes back to login", async () => {
      const browser = await Browser.open();
      const start = await browser.api.get("/auth/sso/start");
      expect(start.headers["location"]).toMatch(/^\/login\?sso_error=/);
      await browser.close();
    });
    await step("DELETE /sso/provider again is 404", async () => {
      expectError(
        await app.api.delete("/sso/provider"),
        404,
        "SSO_NOT_CONFIGURED",
      );
    });
  },
);
