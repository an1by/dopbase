// The e2e harness. A spec file starts with `const app = useServer()`, which
// boots a fresh Dopbase server for that file and stops it afterwards, then
// talks to it through `app.cli`, `app.api`, `app.make` and `app.signIn`.
//
//   import { test, expect, useServer, about, step } from "../harness/index.ts";
//   const app = useServer();
//   test("…", { tag: "@secrets", annotation: about("…") }, async () => {
//     await step("…", async () => { … });
//   });
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  test as base,
  expect,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { ApiClient, type ApiCall } from "./api.ts";
import { CliRun } from "./cli.ts";
import { OidcStub } from "./oidc-stub.ts";
import { about, recordHit } from "./record.ts";
import {
  ROOT_EMAIL,
  ROOT_PASSWORD,
  mintLaunchLink,
  runCli,
  startBrowserLogin,
  startServer,
  type CliResult,
  type RunOptions,
  type Server,
  type ServerOptions,
} from "./server.ts";

export { expect, about };
export { ROOT_EMAIL, ROOT_PASSWORD } from "./server.ts";
export type { OidcStub, OidcUser } from "./oidc-stub.ts";

export type UseServerOptions = ServerOptions & {
  /** Also start the fake OIDC provider, as `app.oidc`. */
  sso?: boolean;
};
export type { ApiResult } from "./api.ts";

/** An account the harness can act as. */
export type Account = { email: string; password: string; id?: string };

export const ROOT: Account = { email: ROOT_EMAIL, password: ROOT_PASSWORD };

export type CliOptions = Omit<RunOptions, "env"> & {
  env?: Record<string, string>;
  /** Run as this account (signed in through `login --browser`), or anonymously. */
  as?: Account | "anonymous";
};

/** E2E_KEEP=1 (or test:e2e --keep): keep the server of a file that failed. */
const KEEP = Boolean(process.env.E2E_KEEP);
/** Names the attachment run.ts and the report read the kept folder from. */
export const KEPT_ATTACHMENT = "kept server";

let currentApp: App | undefined;
let currentPage: Page | undefined;

/** Opens another browser in the same test, e.g. a teammate's. */
export type NewContext = (
  /** Whose browser this is. The report labels its video with it. */
  name: string,
  options?: BrowserContextOptions,
) => Promise<BrowserContext>;

export const test = base.extend<{ newContext: NewContext }>({
  // browser.newContext() doesn't record video, even when the project does.
  // This one follows the project's `video` setting, so a journey's second
  // browser shows up in the report next to the main one.
  newContext: async ({ browser, video }, use, testInfo) => {
    const mode = typeof video === "string" ? video : video.mode;
    const opened: { name: string; context: BrowserContext; pages: Page[] }[] =
      [];
    await use(async (name, options = {}) => {
      const dir = testInfo.outputPath(`video-${opened.length + 1}`);
      const context = await browser.newContext({
        ...(mode === "off" ? {} : { recordVideo: { dir } }),
        ...options,
      });
      const entry = { name, context, pages: [] as Page[] };
      context.on("page", (page) => entry.pages.push(page));
      opened.push(entry);
      return context;
    });
    const failed = testInfo.status !== testInfo.expectedStatus;
    const keep = mode === "on" || (mode !== "off" && failed);
    for (const [index, { name, context, pages }] of opened.entries()) {
      await context.close().catch(() => {});
      for (const page of pages) {
        const path = await page
          .video()
          ?.path()
          .catch(() => undefined);
        if (!path) continue;
        if (keep) {
          testInfo.attachments.push({
            name: `video: ${name}`,
            path,
            contentType: "video/webm",
          });
        }
      }
      if (!keep)
        await rm(testInfo.outputPath(`video-${index + 1}`), {
          recursive: true,
          force: true,
        });
    }
  },
  // Every request and page.goto("/…") goes to the file's own server.
  baseURL: async ({}, use) => {
    await use(currentApp?.url);
  },
  // Records the pages a UI test reaches, for the coverage check, and lets
  // step() attach a screenshot after each step.
  page: async ({ page }, use) => {
    const visit = (url: string) => {
      try {
        const { pathname } = new URL(url);
        if (!pathname.startsWith("/api/")) recordHit("ui", pathname);
      } catch {
        // about:blank and the like.
      }
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visit(frame.url());
    });
    page.on("request", (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        visit(req.url());
      }
    });
    currentPage = page;
    await use(page);
    currentPage = undefined;
  },
});

/**
 * A named step. It shows in the report as one line of the scenario. In a
 * test that uses a browser page, a screenshot is attached after the step.
 */
export function step<T>(title: string, body: () => Promise<T>): Promise<T> {
  return stepOn(currentPage, title, body);
}

/**
 * A named step whose screenshot comes from `page`, e.g. a second person's
 * browser. `step()` always shoots the test's own `page`.
 */
export async function stepOn<T>(
  page: Page | undefined,
  title: string,
  body: () => Promise<T>,
): Promise<T> {
  return test.step(title, async () => {
    const result = await body();
    if (page && !page.isClosed()) {
      try {
        await test.info().attach(`screenshot: ${title}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      } catch {
        // A page mid-navigation can refuse a screenshot; the step still counts.
      }
    }
    return result;
  });
}

/**
 * Runs `dopbase login --browser` through `start` and answers the code it
 * prints over `approver`'s API session, the way a person would in the Admin
 * UI. Resolves with the CLI's result once it exits.
 */
export async function answerBrowserLogin(
  start: (
    opts: Pick<RunOptions, "onStderr" | "signal">,
  ) => PromiseLike<CliResult>,
  approver: ApiClient,
  decision: "approve" | "deny" = "approve",
): Promise<CliResult> {
  const login = startBrowserLogin(start);
  try {
    const { code } = await login.prompt;
    await approver.must(
      "POST",
      `/auth/cli/${decision}`,
      { userCode: code },
      { record: false },
    );
  } catch (error) {
    // Nobody will answer now: stop the CLI instead of letting it time out.
    login.cancel();
    await login.run;
    throw error;
  }
  return login.run;
}

/** Boots a fresh server for this spec file. Call once, at the top level. */
export function useServer(opts: UseServerOptions = {}): App {
  const app = new App(opts);
  test.beforeAll(async ({}, info) => {
    info.setTimeout(90_000);
    await app.start();
    currentApp = app;
  });
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
      app.failed = true;
      await app.attachDiagnostics(info);
    }
  });
  test.afterAll(async ({}, info) => {
    info.setTimeout(30_000);
    try {
      await app.checkLeaks();
    } finally {
      currentApp = undefined;
      // With E2E_KEEP, a file with a failed test keeps its server's files so
      // you can start it again and look around. See App.keep().
      if (KEEP && app.failed) await app.keep();
      else await app.stop();
    }
  });
  return app;
}

export class App {
  readonly options: UseServerOptions;
  /** The fake OIDC provider, when the file asked for `sso: true`. */
  readonly oidc?: OidcStub;
  readonly make: Factories;
  /** Every secret value a test seeded, for the leak check. */
  readonly secrets = new Set<string>();
  /** Set once a test in this file fails; E2E_KEEP then keeps the server. */
  failed = false;
  private server_?: Server;
  private readonly calls: ApiCall[] = [];
  private readonly clients = new Map<string, Promise<ApiClient>>();
  private readonly cliLogins = new Map<string, Promise<string>>();

  constructor(options: UseServerOptions) {
    this.options = options;
    if (options.sso) this.oidc = new OidcStub();
    this.make = new Factories(this);
  }

  get server(): Server {
    if (!this.server_)
      throw new Error("The server is not running yet; use app inside a test");
    return this.server_;
  }
  get url(): string {
    return this.server.url;
  }
  get dataDir(): string {
    return this.server.dataDir;
  }

  async start(): Promise<void> {
    await this.oidc?.start();
    const { sso: _sso, ...serverOptions } = this.options;
    this.server_ = await startServer(serverOptions);
  }

  async stop(): Promise<void> {
    await this.disposeClients();
    await this.server_?.stop();
    await this.oidc?.stop();
    this.server_ = undefined;
  }

  /**
   * Stops the server but keeps its files, with a sandbox.json that tells
   * `bun run test:e2e:sandbox --from <root>` how to start it again.
   */
  async keep(): Promise<void> {
    await this.disposeClients();
    const server = this.server_;
    if (server) {
      await server.halt();
      await writeFile(
        join(server.root, "sandbox.json"),
        JSON.stringify({ env: this.options.env ?? {} }, null, 2),
      );
    }
    await this.oidc?.stop();
    this.server_ = undefined;
  }

  private async disposeClients(): Promise<void> {
    for (const client of this.clients.values()) {
      await (await client.catch(() => undefined))?.dispose();
    }
    this.clients.clear();
  }

  /** A random 32-character value, remembered for the leak check. */
  value(): string {
    const value = `e2e_${randomBytes(14).toString("hex")}`;
    this.secrets.add(value);
    return value;
  }

  /** A name nobody else in this file uses, e.g. `billing-3f2a9c`. */
  uniq(prefix: string): string {
    return `${prefix}-${randomBytes(3).toString("hex")}`;
  }

  /** The API as root, or as `account`, through a browser session. */
  get api(): ApiClient {
    return new Proxy({} as ApiClient, {
      get: (_, prop) => {
        // Not a thenable, or `await app.api` would hang.
        if (prop === "then") return undefined;
        return async (...args: unknown[]) => {
          const client = await this.apiAs(ROOT);
          return (client as any)[prop](...args);
        };
      },
    });
  }

  /** The API with no session. */
  anonymousApi(): Promise<ApiClient> {
    return this.client("anonymous", () =>
      ApiClient.create(this.url, "anonymous", this.calls),
    );
  }

  /** The API signed in as `account` with a browser session (cookie + CSRF). */
  apiAs(account: Account): Promise<ApiClient> {
    return this.client(`browser:${account.email}`, () =>
      ApiClient.signIn(this.url, account, this.calls),
    );
  }

  /** The API with `Authorization: Bearer <token>`, e.g. a personal or runner token. */
  apiWithToken(token: string): Promise<ApiClient> {
    return ApiClient.create(this.url, "token", this.calls, {
      authorization: `Bearer ${token}`,
    });
  }

  private client(
    key: string,
    make: () => Promise<ApiClient>,
  ): Promise<ApiClient> {
    let client = this.clients.get(key);
    if (!client) {
      client = make();
      this.clients.set(key, client);
      client.catch(() => this.clients.delete(key));
    }
    return client;
  }

  /**
   * Runs `dopbase <args>` against this server. By default the CLI is signed
   * in as root; pass `as` for another account or `"anonymous"`.
   */
  cli(args: string[], opts: CliOptions = {}): CliRun {
    const as = opts.as ?? ROOT;
    const env = (async () => {
      const clientDir =
        as === "anonymous"
          ? await this.clientDir("anonymous")
          : await this.cliLogin(as);
      return {
        ...this.server.cliEnv,
        DOPBASE_DATA_DIR: clientDir,
        ...opts.env,
      };
    })();
    return new CliRun(
      args,
      { ...opts, env: undefined },
      () => this.secrets,
      env,
    );
  }

  /** Runs the CLI with exactly this env on top of PATH; no server defaults. */
  cliRaw(args: string[], opts: RunOptions = {}): CliRun {
    return new CliRun(args, opts, () => this.secrets);
  }

  private async clientDir(name: string): Promise<string> {
    const dir = join(
      this.server.root,
      `client-${name.replace(/[^a-z0-9]/gi, "_")}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Signs a CLI client dir in as `account` the way a person would with
   * `dopbase login --browser`: read the code, approve it in a browser
   * session, wait for the CLI to finish. Done once per account per file.
   */
  cliLogin(account: Account): Promise<string> {
    let login = this.cliLogins.get(account.email);
    if (!login) {
      login = (async () => {
        const dir = await this.clientDir(account.email);
        const result = await answerBrowserLogin(
          (opts) =>
            runCli(["login", "--browser"], {
              ...opts,
              env: { ...this.server.cliEnv, DOPBASE_DATA_DIR: dir },
              timeoutMs: 45_000,
            }),
          await this.apiAs(account),
        );
        if (result.code !== 0) {
          throw new Error(
            `dopbase login --browser for ${account.email} failed (exit ${result.code}):\n${result.stderr}`,
          );
        }
        return dir;
      })();
      this.cliLogins.set(account.email, login);
      login.catch(() => this.cliLogins.delete(account.email));
    }
    return login;
  }

  /** A one-time /launch link that signs `email` in to the Admin UI. */
  launchLink(email = ROOT_EMAIL): Promise<string> {
    return mintLaunchLink(this.dataDir, email);
  }

  /** Signs the page in as `account` through a launch link and waits for Projects. */
  async signIn(page: Page, account: Account = ROOT): Promise<void> {
    await page.goto(await this.launchLink(account.email));
    await expect(page).not.toHaveURL(/\/launch/);
  }

  /** Fails the file if any seeded secret value reached the server log. */
  async checkLeaks(): Promise<void> {
    if (!this.server_) return;
    const log = await this.server_.log();
    const leaked = [...this.secrets].filter((value) => log.includes(value));
    if (leaked.length) {
      throw new Error(
        `${leaked.length} seeded secret value(s) appeared in the server log, e.g. ${leaked[0]}`,
      );
    }
  }

  /** Attaches the server log tail and the last API calls to a failed test. */
  async attachDiagnostics(info: TestInfo): Promise<void> {
    if (this.server_ && KEEP) {
      await info.attach(KEPT_ATTACHMENT, {
        body: [
          `This file's server is kept in ${this.server_.root}`,
          "Start it again, signed in as root, with:",
          `  bun run test:e2e:sandbox --from ${this.server_.root}`,
        ].join("\n"),
        contentType: "text/plain",
      });
    }
    if (this.server_) {
      const lines = (await this.server_.log()).split("\n");
      await info.attach("server.log", {
        body: lines.slice(-200).join("\n"),
        contentType: "text/plain",
      });
    }
    if (this.calls.length) {
      await info.attach("api-calls.json", {
        body: JSON.stringify(this.calls, null, 2),
        contentType: "application/json",
      });
    }
  }
}

export type Project = { id: string; name: string };
export type Environment = {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  protected: boolean;
  /** `project/environment`, as the CLI takes it. */
  ref: string;
};
export type User = Account & { id: string; roleId?: string | null };

// Factory calls are setup, so they don't count toward coverage.
const QUIET = { record: false } as const;

/** Creates test data through the API as root. */
export class Factories {
  private readonly app: App;
  constructor(app: App) {
    this.app = app;
  }

  /** A random secret value, remembered for the leak check. */
  value(): string {
    return this.app.value();
  }

  async project(name = this.app.uniq("proj")): Promise<Project> {
    return this.app.api.must("POST", "/projects", { name }, QUIET);
  }

  async environment(
    opts: { project?: Project; name?: string; protected?: boolean } = {},
  ): Promise<Environment> {
    const project = opts.project ?? (await this.project());
    const env = await this.app.api.must(
      "POST",
      `/projects/${encodeURIComponent(project.name)}/environments`,
      { name: opts.name ?? "dev", protected: opts.protected ?? false },
      QUIET,
    );
    return { ...env, ref: `${env.projectName}/${env.name}` };
  }

  /** Sets `key` in `env` and returns the value. */
  async secret(
    env: Environment,
    key = "API_KEY",
    value = this.value(),
  ): Promise<string> {
    this.app.secrets.add(value);
    await this.app.api.must(
      "PUT",
      `/environments/${env.id}/secrets/${encodeURIComponent(key)}`,
      { value },
      QUIET,
    );
    return value;
  }

  /** The id of a role by its display name, e.g. "Member". */
  async roleId(name: string): Promise<string> {
    const roles: { id: string; name: string }[] = await this.app.api.must(
      "GET",
      "/roles",
      undefined,
      QUIET,
    );
    const role = roles.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!role)
      throw new Error(
        `No role named ${name}: ${roles.map((r) => r.name).join(", ")}`,
      );
    return role.id;
  }

  /** A person with a password, by default a Member. */
  async user(
    opts: { role?: string; email?: string; password?: string } = {},
  ): Promise<User> {
    const email = opts.email ?? `${this.app.uniq("user")}@dopbase.com`;
    const password = opts.password ?? `pw-${randomBytes(12).toString("hex")}`;
    const created = await this.app.api.must(
      "POST",
      "/users",
      {
        email,
        password,
        roleId: await this.roleId(opts.role ?? "Member"),
      },
      QUIET,
    );
    return { ...created, email, password };
  }
}
