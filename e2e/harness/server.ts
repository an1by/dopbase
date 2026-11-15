// Starts a real Dopbase server for end-to-end tests and runs the CLI against
// it. A fresh data dir, the setup token from the server log, then
// POST /api/v1/bootstrap/admin to claim root.
//
// Only node: modules are used here, so the same code runs under Playwright
// (Node) and under Bun scripts such as e2e/coverage/check.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT_EMAIL = "root@dopbase.com";
export const ROOT_PASSWORD = "e2e-fixture-password-123";

export type ServerOptions = {
  /** Extra env for the server process, e.g. `{ DOPBASE_RBAC: "false" }`. */
  env?: Record<string, string>;
  /** Copy this data dir instead of starting empty. Skips the root claim. */
  dataDir?: string;
  /** Claim root after boot. Off for bootstrap and first-run tests. */
  claimRoot?: boolean;
  /** Serve Swagger UI at /api/docs. */
  docs?: boolean;
  /**
   * Serve the Admin UI. `false` passes --no-web-ui, which only boots a data
   * dir that is already set up (a fresh one asks for `dopbase server setup`).
   */
  webUi?: boolean;
  /** Extra arguments for `server start`. */
  args?: string[];
  /** Listen on this port instead of a free one. A taken port isn't retried. */
  port?: number;
};

export type Server = {
  url: string;
  port: number;
  /** Temp root holding the data dir, HOME and the server log. */
  root: string;
  dataDir: string;
  logPath: string;
  /** The `setup_…` token, when the server printed one. */
  setupToken?: string;
  /** Env for CLI calls: points at this server and keeps client config in the temp dir. */
  cliEnv: Record<string, string>;
  /** Reads everything the server has written to stdout and stderr so far. */
  log: () => Promise<string>;
  /** Stops the process and keeps every file, so it can start again. */
  halt: () => Promise<void>;
  /** Stops the process and deletes `root`. */
  stop: () => Promise<void>;
};

export type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

/** The binary under test. Set DOPBASE_BIN to test a different build. */
export function binaryPath(): string {
  return (
    process.env.DOPBASE_BIN ??
    resolve(import.meta.dirname, "../../app/target/release/dopbase")
  );
}

// Child processes get PATH and the values set here, nothing else. A
// DOPBASE_TOKEN or DOPBASE_URL in your shell must never reach a test.
export function cleanEnv(
  extra: Record<string, string>,
): Record<string, string> {
  return { PATH: process.env.PATH ?? "", ...extra };
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

type Boot = { setupToken?: string };

// Resolves once the server prints its setup token, or, for a data dir that
// is already set up, once it answers health. It only reads the boot output
// and lets go of it afterwards; bootOnce writes the log.
function waitForBoot(
  child: ChildProcess,
  url: string,
  expectToken: boolean,
): Promise<Boot> {
  return new Promise((done, fail) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error, boot?: Boot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) fail(error);
      else done(boot ?? {});
    };
    const timer = setTimeout(
      () => finish(new Error(`Server did not start within 20s:\n${output}`)),
      20_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      // The trailing \s waits for the whole token when a chunk splits it.
      const match = output.match(/^(setup_\S+)\s/m);
      if (expectToken && match) finish(undefined, { setupToken: match[1] });
    };
    const onExit = (code: number | null) =>
      finish(new Error(`Server exited with code ${code}:\n${output}`));
    const onError = (error: Error) =>
      finish(new Error(`Server failed to start: ${error.message}\n${output}`));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    if (!expectToken) {
      waitForHealth(url).then(
        () => finish(),
        (error: Error) => finish(error),
      );
    }
  });
}

export async function waitForHealth(url: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((wait) => setTimeout(wait, 250));
  }
  throw new Error(`Server at ${url} never became healthy`);
}

async function bootOnce(root: string, opts: ServerOptions): Promise<Server> {
  const dataDir = join(root, "data");
  const logPath = join(root, "server.log");
  // An empty data dir prints a setup token; a set-up one only answers health.
  const fresh = !opts.dataDir && !existsSync(join(dataDir, "dopbase.db"));
  const port = opts.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const args = [
    "--data-dir",
    dataDir,
    "server",
    "start",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--public-url",
    url,
  ];
  if (opts.docs) args.push("--docs");
  if (opts.webUi === false) args.push("--no-web-ui");
  args.push(...(opts.args ?? []));

  await mkdir(root, { recursive: true });
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn(binaryPath(), args, {
    env: cleanEnv({ HOME: root, DOPBASE_ROOT_EMAIL: "", ...opts.env }),
  });
  // "close" comes after the process exits and both pipes have ended, so no
  // output arrives after it. A failed spawn (e.g. ENOENT for a missing
  // binary) emits only "error": without a listener it would crash the
  // worker, and "close" would never come, so it settles `closed` too.
  const closed = new Promise<void>((done) => {
    child.once("close", () => done());
    child.on("error", (error) => {
      log.write(`spawn error: ${error.message}\n`);
      done();
    });
  });
  // One listener for the life of the server: it copies the output to the
  // log and keeps the pipes drained, or the server blocks once a pipe
  // buffer fills.
  const toLog = (chunk: Buffer) => log.write(chunk);
  child.stdout?.on("data", toLog);
  child.stderr?.on("data", toLog);

  // Once only: a second call waits for the first instead of ending the log twice.
  let stopping: Promise<void> | undefined;
  const stopChild = () =>
    (stopping ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await closed;
      await new Promise<void>((done) => log.end(done));
    })());

  let boot: Boot;
  try {
    boot = await waitForBoot(child, url, fresh);
    await waitForHealth(url);
  } catch (error) {
    await stopChild();
    throw error;
  }

  return {
    url,
    port,
    root,
    dataDir,
    logPath,
    setupToken: boot.setupToken,
    cliEnv: {
      HOME: root,
      DOPBASE_URL: url,
      DOPBASE_DATA_DIR: join(root, "client"),
    },
    log: async () =>
      existsSync(logPath) ? await readFile(logPath, "utf8") : "",
    halt: stopChild,
    stop: async () => {
      await stopChild();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Starts a fresh server, with root claimed unless `claimRoot: false`. */
export async function startServer(opts: ServerOptions = {}): Promise<Server> {
  const root = await mkdtemp(join(tmpdir(), "dopbase-e2e-"));
  if (opts.dataDir) {
    await cp(opts.dataDir, join(root, "data"), { recursive: true });
  }
  try {
    return await startServerIn(root, {
      ...opts,
      claimRoot: opts.claimRoot ?? !opts.dataDir,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Starts a server on `root/data`, with HOME and the log in `root`, and
 * claims root only with `claimRoot: true`. Unlike `startServer` the files
 * are the caller's: use `halt()` to stop it and start it again later, e.g.
 * around offline commands such as `admin factory-reset`.
 */
export async function startServerIn(
  root: string,
  opts: ServerOptions = {},
): Promise<Server> {
  // Another worker can take the same free port between the probe and the
  // bind, so a failed boot is retried on a new port.
  let server: Server | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3 && !server; attempt++) {
    try {
      server = await bootOnce(root, opts);
    } catch (error) {
      lastError = error;
      if (opts.port || !String(error).includes("in use")) break;
    }
  }
  if (!server) throw lastError;

  if (opts.claimRoot) {
    try {
      await claimRoot(server);
    } catch (error) {
      await server.halt();
      throw error;
    }
  }
  return server;
}

export async function claimRoot(
  server: Server,
  email = ROOT_EMAIL,
  password = ROOT_PASSWORD,
): Promise<Response> {
  const claim = await fetch(`${server.url}/api/v1/bootstrap/admin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupToken: server.setupToken, email, password }),
  });
  if (!claim.ok) {
    throw new Error(
      `Claiming root failed: ${claim.status} ${await claim.text()}`,
    );
  }
  return claim;
}

export type RunOptions = {
  env?: Record<string, string>;
  /** Written to standard input, which is then closed. */
  stdin?: string;
  /** Called with each chunk of stderr, e.g. to read a login code. */
  onStderr?: (text: string) => void;
  /** Called with all stdout so far after each chunk, e.g. to see a watch start. */
  onStdout?: (text: string) => void;
  timeoutMs?: number;
  /** Aborting it kills the CLI, e.g. a login nobody will approve. */
  signal?: AbortSignal;
  /** False keeps setup and cleanup calls out of CLI coverage. */
  record?: boolean;
};

/** Runs the dopbase CLI with a clean environment plus `env`. */
export async function runCli(
  args: string[],
  opts: RunOptions = {},
): Promise<CliResult> {
  const child = spawn(binaryPath(), args, { env: cleanEnv(opts.env ?? {}) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    opts.onStdout?.(stdout);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    opts.onStderr?.(stderr);
  });
  if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
  child.stdin.end();
  const kill = () => child.kill("SIGKILL");
  const timer = setTimeout(kill, opts.timeoutMs ?? 60_000);
  opts.signal?.addEventListener("abort", kill, { once: true });
  const [code] = (await once(child, "close")) as [number | null];
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", kill);
  return { code, stdout, stderr };
}

/** What `dopbase login --browser` prints for the person to act on. */
export type LoginPrompt = { url: string; code: string };

/** A `dopbase login --browser` that is running and waiting for the browser. */
export type PendingLogin<R> = {
  /** The approval link and code; rejects if the CLI exits before both show. */
  prompt: Promise<LoginPrompt>;
  /** The CLI run itself. Settles once it exits. */
  run: R;
  /** Kills the CLI. */
  cancel: () => void;
};

/**
 * Starts `dopbase login --browser` through `start` (e.g. `runCli` or
 * `app.cliRaw` with these options merged in) and reads the approval link and
 * code off stderr. Stderr can split them across chunks, so each counts only
 * once the whitespace after it has arrived.
 */
export function startBrowserLogin<R extends PromiseLike<CliResult>>(
  start: (opts: Pick<RunOptions, "onStderr" | "signal">) => R,
): PendingLogin<R> {
  const abort = new AbortController();
  let found!: (prompt: LoginPrompt) => void;
  const shown = new Promise<LoginPrompt>((done) => (found = done));
  const run = start({
    signal: abort.signal,
    onStderr: (text) => {
      const url = text.match(/(http\S+\/cli\/approve\S*)\s/)?.[1];
      const code = text.match(/shows this code:\s+(\S+)\s/)?.[1];
      if (url && code) found({ url, code });
    },
  });
  const exited = Promise.resolve(run).then((result): never => {
    throw new Error(
      `dopbase login --browser exited ${result.code} before printing the approval link:\n${result.stderr}`,
    );
  });
  return {
    prompt: Promise.race([shown, exited]),
    run,
    cancel: () => abort.abort(),
  };
}

/** Mints a one-time /launch link with `dopbase admin passcode`. */
export async function mintLaunchLink(
  dataDir: string,
  email = ROOT_EMAIL,
): Promise<string> {
  const result = await runCli([
    "--data-dir",
    dataDir,
    "--json",
    "admin",
    "passcode",
    email,
  ]);
  if (result.code !== 0) {
    throw new Error(`admin passcode failed:\n${result.stderr}`);
  }
  const link = result.stdout.match(/\/launch#[^"\s]+/)?.[0];
  if (!link) throw new Error(`No launch link in:\n${result.stdout}`);
  return link;
}
