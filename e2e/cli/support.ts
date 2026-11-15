// Helpers shared by the CLI specs: a CLI login in a fresh client dir,
// throwaway instances for the server lifecycle and offline admin commands,
// a TCP proxy that can be cut to make the server look down, and an HTTP
// proxy that records User-Agents and changes the server's version header.
import { once } from "node:events";
import { chmod, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type Server as HttpServer,
} from "node:http";
import {
  createServer,
  connect,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { printVar, tempDir } from "../harness/helpers.ts";
import {
  ROOT,
  answerBrowserLogin,
  expect,
  type Account,
  type App,
} from "../harness/index.ts";
import { freePort, startServerIn, type Server } from "../harness/server.ts";

/**
 * The value `dopbase run <ref>` injects for `key`, read back by a child
 * shell, as root.
 */
export async function injected(
  app: App,
  ref: string,
  key: string,
): Promise<string> {
  const result = await app.cli(["run", ref, "--", ...printVar(key)]).ok();
  return result.stdout;
}

/** Env for a CLI process signed in as `account` (root by default). */
export async function signedInEnv(
  app: App,
  account: Account = ROOT,
): Promise<Record<string, string>> {
  return {
    ...app.server.cliEnv,
    DOPBASE_DATA_DIR: await app.cliLogin(account),
  };
}

/** Env for a CLI process with an empty client dir of its own. */
export async function freshClientEnv(
  app: App,
  prefix = "client",
): Promise<Record<string, string>> {
  return {
    ...app.server.cliEnv,
    DOPBASE_DATA_DIR: await tempDir(app, prefix),
  };
}

/**
 * Runs `dopbase login --browser` with `env` and approves (or denies) the
 * code it prints through `account`'s browser session, the way a person
 * would in the Admin UI.
 */
export async function browserLogin(
  app: App,
  env: Record<string, string>,
  opts: { account?: Account; decision?: "approve" | "deny" } = {},
) {
  return answerBrowserLogin(
    (run) =>
      app.cliRaw(["login", "--browser"], { ...run, env, timeoutMs: 45_000 }),
    await app.apiAs(opts.account ?? ROOT),
    opts.decision,
  );
}

/** A file in a fresh temp dir with these contents. */
export async function writeTemp(
  app: App,
  name: string,
  contents: string,
): Promise<string> {
  const path = join(await tempDir(app, "file"), name);
  await writeFile(path, contents);
  return path;
}

/** Writes an executable shell script and returns its path. */
export async function script(
  app: App,
  name: string,
  body: string,
): Promise<string> {
  const path = join(await tempDir(app, "bin"), name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/**
 * A data dir and HOME of its own, for `server` and offline `admin` commands
 * that must not touch the file's shared server.
 */
export class Instance {
  readonly app: App;
  readonly dir: string;
  readonly dataDir: string;
  readonly env: Record<string, string>;
  port = 0;
  private readonly foreground: Server[] = [];

  private constructor(app: App, dir: string) {
    this.app = app;
    this.dir = dir;
    this.dataDir = join(dir, "data");
    this.env = { HOME: dir };
  }

  static async create(app: App, prefix = "instance"): Promise<Instance> {
    const instance = new Instance(app, await tempDir(app, prefix));
    instance.port = await freePort();
    return instance;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Listener options for `server start`. */
  get listen(): string[] {
    return [
      "--host",
      "127.0.0.1",
      "--port",
      String(this.port),
      "--public-url",
      this.url,
    ];
  }

  /** `dopbase --data-dir <dir> <args>` with this instance's HOME. */
  cli(args: string[], env: Record<string, string> = {}) {
    return this.app.cliRaw(["--data-dir", this.dataDir, ...args], {
      env: { ...this.env, ...env },
      timeoutMs: 45_000,
    });
  }

  /** `server setup --email` and the generated password. */
  async setup(email = "owner@dopbase.com"): Promise<string> {
    const result = await this.cli([
      "--json",
      "server",
      "setup",
      "--email",
      email,
    ]).json();
    expect(result.initialized).toBe(true);
    return result.password as string;
  }

  /**
   * Starts `server start <args>` in the foreground as a child process and
   * waits for it to answer health (and, for a fresh instance, to print its
   * setup token). Stopped by `stop()`.
   */
  async startForeground(
    args: string[] = [],
    env: Record<string, string> = {},
  ): Promise<Server> {
    const server = await startServerIn(this.dir, {
      port: this.port,
      args,
      env: { ...this.env, ...env },
    });
    this.foreground.push(server);
    return server;
  }

  /** Stops foreground children and any background server. */
  async stop(): Promise<void> {
    for (const server of this.foreground) await server.halt();
    this.foreground.length = 0;
    await this.app.cliRaw(
      ["--data-dir", this.dataDir, "server", "stop", "--timeout", "2"],
      { env: this.env, record: false },
    );
  }
}

/** POST /api/v1/auth/login with a password; returns the status code. */
export async function passwordLogin(
  url: string,
  email: string,
  password: string,
): Promise<number> {
  const response = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, sessionKind: "browser" }),
  });
  return response.status;
}

/**
 * A TCP proxy in front of the server. CLI calls through `proxy.url` reach
 * the server until `cut()`, after which connections are refused, the way a
 * stopped server looks to the CLI.
 */
export class Proxy {
  private readonly server: NetServer;
  private readonly sockets: Set<Socket>;
  readonly port: number;

  private constructor(server: NetServer, sockets: Set<Socket>, port: number) {
    this.server = server;
    this.sockets = sockets;
    this.port = port;
  }

  static async start(targetPort: number): Promise<Proxy> {
    const sockets = new Set<Socket>();
    const server = createServer((client) => {
      const upstream = connect(targetPort, "127.0.0.1");
      sockets.add(client);
      sockets.add(upstream);
      client.pipe(upstream).pipe(client);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on("error", drop);
      upstream.on("error", drop);
      client.on("close", drop);
      upstream.on("close", drop);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return new Proxy(server, sockets, port);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Closes the listener and every open connection. */
  async cut(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((done) => this.server.close(() => done()));
  }
}

/**
 * An HTTP proxy in front of the server. It records the User-Agent of every
 * request and sets `x-dopbase-version` on each response to `serverVersion`:
 * a version to pretend the server runs, `null` to drop the header the way an
 * older server answers, or `undefined` to pass it through.
 */
export class VersionProxy {
  readonly userAgents: (string | undefined)[] = [];
  serverVersion: string | null | undefined = undefined;
  private readonly server: HttpServer;
  readonly port: number;

  private constructor(server: HttpServer, port: number) {
    this.server = server;
    this.port = port;
  }

  static async start(target: string): Promise<VersionProxy> {
    const upstream = new URL(target);
    let proxy: VersionProxy | undefined;
    const server = createHttpServer((incoming, outgoing) => {
      proxy!.userAgents.push(incoming.headers["user-agent"]);
      const forwarded = httpRequest(
        {
          host: upstream.hostname,
          port: upstream.port,
          method: incoming.method,
          path: incoming.url,
          headers: { ...incoming.headers, host: upstream.host },
        },
        (response) => {
          const headers = { ...response.headers };
          const version = proxy!.serverVersion;
          if (version === null) delete headers["x-dopbase-version"];
          else if (version !== undefined)
            headers["x-dopbase-version"] = version;
          outgoing.writeHead(response.statusCode ?? 502, headers);
          response.pipe(outgoing);
        },
      );
      forwarded.on("error", () => outgoing.destroy());
      incoming.pipe(forwarded);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    proxy = new VersionProxy(server, port);
    return proxy;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((done) => this.server.close(() => done()));
  }
}

// node:sqlite has no type definitions in this workspace, so it is loaded by
// name at runtime.
const SQLITE = "node:sqlite";

async function open(dataDir: string, readOnly: boolean) {
  const { DatabaseSync } = await import(SQLITE);
  const db = new DatabaseSync(join(dataDir, "dopbase.db"), { readOnly });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** Runs one SQL statement against the instance database in `dataDir`. */
export async function sql(
  dataDir: string,
  statement: string,
  ...params: unknown[]
): Promise<void> {
  const db = await open(dataDir, false);
  try {
    db.prepare(statement).run(...params);
  } finally {
    db.close();
  }
}

/** Reads rows from the instance database in `dataDir`. */
export async function query<T = Record<string, unknown>>(
  dataDir: string,
  statement: string,
  ...params: unknown[]
): Promise<T[]> {
  const db = await open(dataDir, true);
  try {
    return db.prepare(statement).all(...params) as T[];
  } finally {
    db.close();
  }
}
