// Builds a 0.1.x upgrade fixture: downloads that release's binary for this
// machine, boots it on an empty data dir, seeds people, an AI agent,
// projects, secrets that were changed several times, tokens and the audit
// trail that comes with all that, takes a backup, and saves what a 0.2.0
// restore needs into v<version>/:
//
//   backup.dop       the 0.1.x backup
//   master.key       the key it was encrypted with (raw 32 bytes)
//   data-dir.tar.gz  the stopped 0.1.x data dir, for the start-refusal check
//   seed.json        what was seeded, so upgrade.spec.ts knows what to expect
//
// Run it with `bun run --cwd e2e fixture:upgrade [version]`, 0.1.10 by
// default; upgrade.spec.ts runs once per fixture it lists. It needs `gh` signed in
// with read access to dopbase/dopbase. Every value here is a throwaway test
// value made for this fixture.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanEnv,
  freePort,
  ROOT_EMAIL,
  ROOT_PASSWORD,
  waitForHealth,
} from "../../harness/server.ts";

const VERSION = process.argv[2] ?? "0.1.10";
if (!/^0\.1\.\d+$/.test(VERSION)) {
  throw new Error(`Expected a 0.1.x version, got ${VERSION}`);
}
const REPO = "dopbase/dopbase";
const OUT = join(import.meta.dirname, `v${VERSION}`);

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

/** The release asset for this machine, e.g. dopbase_0.1.10_darwin_arm64.tar.gz. */
function assetName(): string {
  const os = { darwin: "darwin", linux: "linux" }[process.platform as string];
  const arch = { arm64: "arm64", x64: "amd64" }[process.arch as string];
  if (!os || !arch) {
    throw new Error(
      `No ${VERSION} release for ${process.platform}/${process.arch}`,
    );
  }
  return `dopbase_${VERSION}_${os}_${arch}.tar.gz`;
}

/** Downloads the release into its own empty dir, checks its checksum, extracts it. */
async function download(work: string): Promise<string> {
  const asset = assetName();
  const downloads = join(work, "download");
  await mkdir(downloads);
  run("gh", [
    "release",
    "download",
    VERSION,
    "--repo",
    REPO,
    "--pattern",
    asset,
    "--pattern",
    "checksums.txt",
    "--dir",
    downloads,
  ]);
  const sums = await readFile(join(downloads, "checksums.txt"), "utf8");
  const expected = sums
    .split("\n")
    .find((line) => line.trim().endsWith(asset))
    ?.split(/\s+/)[0];
  const actual = createHash("sha256")
    .update(new Uint8Array(await readFile(join(downloads, asset))))
    .digest("hex");
  if (!expected || expected !== actual) {
    throw new Error(`Checksum mismatch for ${asset}: ${actual} vs ${expected}`);
  }
  const bin = join(work, "bin");
  await mkdir(bin);
  run("tar", ["-xzf", join(downloads, asset), "-C", bin, "dopbase"]);
  return join(bin, "dopbase");
}

type Old = {
  url: string;
  call: (method: string, path: string, body?: unknown) => Promise<any>;
  stop: () => Promise<void>;
};

/** Boots the old binary, claims root and signs in with a browser session. */
async function boot(binary: string, work: string): Promise<Old> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    binary,
    [
      "--data-dir",
      join(work, "data"),
      "server",
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--public-url",
      url,
    ],
    { env: cleanEnv({ HOME: work }) },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await once(child, "exit");
  };
  try {
    return await claim(url, () => output, stop);
  } catch (error) {
    // Don't leave the old server running on a data dir main() deletes.
    await stop();
    throw error;
  }
}

/** Claims root on a booted 0.1.x server and signs in with a browser session. */
async function claim(
  url: string,
  log: () => string,
  stop: () => Promise<void>,
): Promise<Old> {
  await waitForHealth(url);
  const setupToken = log().match(/setup_[A-Za-z0-9_-]+/)?.[0];
  if (!setupToken) throw new Error(`No setup token in:\n${log()}`);
  const json = async (res: Response) => {
    const body: any = await res.json();
    if (!res.ok) throw new Error(`${res.url}: ${JSON.stringify(body)}`);
    return body;
  };
  await json(
    await fetch(`${url}/api/v1/bootstrap/admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        setupToken,
        email: ROOT_EMAIL,
        password: ROOT_PASSWORD,
      }),
    }),
  );
  const login = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: ROOT_EMAIL,
      password: ROOT_PASSWORD,
      sessionKind: "browser",
    }),
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const csrf = (await json(login)).data.csrfToken;
  return {
    url,
    call: async (method, path, body) =>
      (
        await json(
          await fetch(`${url}/api/v1${path}`, {
            method,
            headers: {
              cookie,
              "x-dopbase-csrf": csrf,
              "content-type": "application/json",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        )
      ).data,
    stop,
  };
}

/** A fixture value, recognisable in logs and leak checks. */
const value = (name: string) =>
  `upgrade_fixture_${name}_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;

async function seed(old: Old) {
  const people = [
    {
      email: "ada@dopbase.com",
      password: "ada-fixture-password-1",
      role: "admin",
    },
    {
      email: "max@dopbase.com",
      password: "max-fixture-password-1",
      role: "member",
    },
  ];
  const created: Record<string, string> = {};
  for (const person of people) {
    created[person.email] = (await old.call("POST", "/users", person)).id;
  }
  // Max moves from member to admin and back: a role change in the audit log.
  await old.call("PATCH", `/users/${created["max@dopbase.com"]}`, {
    role: "admin",
  });
  await old.call("PATCH", `/users/${created["max@dopbase.com"]}`, {
    role: "member",
  });

  const bot = await old.call("POST", "/service-accounts", {
    name: "deploy-bot",
  });
  const botToken = await old.call(
    "POST",
    `/service-accounts/${bot.id}/tokens`,
    {
      name: "ci",
      expiresIn: "30d",
    },
  );

  const project = await old.call("POST", "/projects", { name: "shop" });
  const dev = await old.call("POST", "/projects/shop/environments", {
    name: "dev",
  });
  const prod = await old.call("POST", "/projects/shop/environments", {
    name: "prod",
  });
  // API_KEY is written three times; only the last value is current.
  const apiKeys = [
    value("api_key_v1"),
    value("api_key_v2"),
    value("api_key_v3"),
  ];
  for (const v of apiKeys) {
    await old.call("PUT", `/environments/${dev.id}/secrets/API_KEY`, {
      value: v,
    });
  }
  await old.call("PUT", `/environments/${dev.id}/secrets/DATABASE_URL`, {
    value: value("database_url"),
  });
  await old.call("PUT", `/environments/${prod.id}/secrets/API_KEY`, {
    value: value("prod_api_key"),
  });
  const removed = value("removed");
  await old.call("PUT", `/environments/${prod.id}/secrets/OLD_FLAG`, {
    value: removed,
  });
  await old.call("DELETE", `/environments/${prod.id}/secrets/OLD_FLAG`);
  const runner = await old.call("POST", `/environments/${dev.id}/tokens`, {
    name: "ci-dev",
    role: "runner",
  });
  // A second project, renamed, then deleted: its events stay in the log.
  await old.call("POST", "/projects", { name: "scratch" });
  await old.call("PATCH", "/projects/scratch", { name: "scratch-old" });
  await old.call("DELETE", "/projects/scratch-old");

  const audit = await old.call("GET", "/audit-events?limit=200");
  const backup = await old.call("POST", "/backups", { name: "before-0-2" });
  return {
    version: VERSION,
    root: { email: ROOT_EMAIL, password: ROOT_PASSWORD },
    people: people.map((p) => ({ ...p, id: created[p.email] })),
    agent: { id: bot.id, name: bot.name, token: botToken.plaintextToken },
    project: { id: project.id, name: "shop" },
    environments: { dev: dev.id, prod: prod.id },
    secrets: {
      dev: { API_KEY: apiKeys[2], DATABASE_URL: value("database_url") },
      prod: { API_KEY: value("prod_api_key") },
    },
    apiKeyVersion: apiKeys.length,
    deletedSecret: { environment: "prod", key: "OLD_FLAG", value: removed },
    runnerToken: { id: runner.token.id, token: runner.plaintextToken },
    auditEventsBefore: audit.items.length,
    backupKey: backup.key,
  };
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), "dopbase-fixture-"));
  try {
    const binary = await download(work);
    console.log(`dopbase ${run(binary, ["--version"]).trim()} downloaded`);
    const old = await boot(binary, work);
    let seeded: Awaited<ReturnType<typeof seed>>;
    try {
      seeded = await seed(old);
    } finally {
      await old.stop();
    }
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
    await copyFile(
      join(work, "data", "backups", seeded.backupKey),
      join(OUT, "backup.dop"),
    );
    await copyFile(join(work, "data", "master.key"), join(OUT, "master.key"));
    // The stopped data dir, without the backup inside it, for the check
    // that 0.2.0 refuses to start on 0.1.x data.
    await rm(join(work, "data", "backups"), { recursive: true, force: true });
    await rm(join(work, "data", "dopbase.db.lock"), { force: true });
    run("tar", ["-czf", join(OUT, "data-dir.tar.gz"), "-C", work, "data"]);
    await writeFile(
      join(OUT, "seed.json"),
      `${JSON.stringify(seeded, null, 2)}\n`,
    );
    console.log(`Wrote ${OUT}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();
