// Builds e2e/docker/Dockerfile and runs every test layer inside it.
// The report lands in ./.e2e as with a local run; Cargo's registry and
// target dir live in Docker volumes so later runs don't rebuild everything.
//
//   bun run test:e2e:docker [-- <args for bun run test>]
//
// With no args the image runs `bun run test -- --agent`. Args replace that
// default, so add --agent yourself if you want the short summary.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const IMAGE = "dopbase-e2e";

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const build = spawnSync(
  "docker",
  ["build", "--file", "e2e/docker/Dockerfile", "--tag", IMAGE, "."],
  { cwd: ROOT, stdio: "inherit" },
);
if (build.error) console.error(`Cannot run docker: ${build.error.message}`);
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(join(ROOT, ".e2e"), { recursive: true });
const extra = process.argv.slice(2).filter((arg) => arg !== "--");
const run = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    // An init process reaps exited daemons; without it they stay as zombies
    // and the CLI's background-server tests think they never stopped.
    "--init",
    "--ipc=host",
    "--volume",
    `${join(ROOT, ".e2e")}:/workspace/.e2e`,
    "--volume",
    "dopbase-e2e-cargo:/usr/local/cargo/registry",
    "--volume",
    "dopbase-e2e-target:/workspace/app/target",
    "--env",
    `GIT_BRANCH=${git(["rev-parse", "--abbrev-ref", "HEAD"])}`,
    "--env",
    `GIT_COMMIT=${git(["rev-parse", "--short", "HEAD"])}`,
    ...(process.env.CI ? ["--env", "CI=1"] : []),
    IMAGE,
    ...(extra.length ? ["bun", "run", "test", "--", ...extra] : []),
  ],
  { cwd: ROOT, stdio: "inherit" },
);

// The tests run as root, so on Linux everything they wrote to ./.e2e is
// owned by root and the next local run can't clean it up. Hand it back,
// even when the run failed or was interrupted.
const uid = process.getuid?.();
const gid = process.getgid?.();
if (uid !== undefined && gid !== undefined && uid !== 0) {
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--volume",
      `${join(ROOT, ".e2e")}:/workspace/.e2e`,
      IMAGE,
      "chown",
      "-R",
      `${uid}:${gid}`,
      "/workspace/.e2e",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );
}
process.exit(run.status ?? 1);
