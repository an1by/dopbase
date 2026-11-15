// A server a journey starts and stops itself, for stories that take the
// server down (factory reset, restore) and bring it back on the same files.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { ApiClient } from "../harness/api.ts";
import { answerBrowserLogin, type Account } from "../harness/index.ts";
import { runCli, startServerIn, type Server } from "../harness/server.ts";

/**
 * A server the test starts and stops itself, on a data dir that outlives
 * the process. The harness server can't do that: its `stop()` also deletes
 * the data dir, and offline commands such as `admin factory-reset` need the
 * server stopped with its files still there.
 */
export class LocalServer {
  readonly root: string;
  readonly dataDir: string;
  readonly logPath: string;
  /** Kept after stop(), so a test can check the old address went quiet. */
  url = "";
  setupToken?: string;
  private server?: Server;

  constructor(root: string) {
    this.root = root;
    this.dataDir = join(root, "data");
    this.logPath = join(root, "server.log");
  }

  /** CLI env pointing at this server, with client state under `root`. */
  cliEnv(clientDir = join(this.root, "client")): Record<string, string> {
    return {
      HOME: this.root,
      DOPBASE_URL: this.url,
      DOPBASE_DATA_DIR: clientDir,
    };
  }

  /** Boots on the data dir; on an empty one, also waits for the setup token. */
  async start(): Promise<void> {
    this.server = await startServerIn(this.root);
    this.url = this.server.url;
    this.setupToken = this.server.setupToken;
  }

  /** Stops the process and keeps every file. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await server?.halt();
  }

  async log(): Promise<string> {
    return existsSync(this.logPath) ? readFile(this.logPath, "utf8") : "";
  }

  /** An API session signed in with a password, like `app.apiAs`. */
  apiAs(account: Account): Promise<ApiClient> {
    return ApiClient.signIn(this.url, account);
  }

  /**
   * Signs a new CLI client dir in as `account` with `login --browser`,
   * approving the code over the API, and returns the env to use it.
   */
  async cliLogin(account: Account): Promise<Record<string, string>> {
    const env = this.cliEnv(join(this.root, `client-${randomUUID()}`));
    const api = await this.apiAs(account);
    try {
      const result = await answerBrowserLogin(
        (run) =>
          runCli(["login", "--browser"], { ...run, env, timeoutMs: 45_000 }),
        api,
      );
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await api.dispose();
    }
    return env;
  }
}
