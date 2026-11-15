// Keeps the release binary the e2e suites and the sandbox run in step with
// its sources: rebuilds the Admin UI and then the binary when either changed.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  // The directory's own time moves when a file in it is deleted or renamed.
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path)) {
    if (
      entry === "node_modules" ||
      entry === ".DS_Store" ||
      entry.endsWith(".test.ts")
    )
      continue;
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
}

/** Runs a build step. Quiet mode keeps its output unless it fails. */
function run(command: string, args: string[], quiet: boolean): number {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: quiet ? "pipe" : "inherit",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (quiet && result.status !== 0) {
    process.stdout.write(String(result.stdout ?? ""));
    process.stderr.write(String(result.stderr ?? ""));
  }
  return result.status ?? 1;
}

/**
 * Rebuilds the UI and the release binary when their sources are newer.
 * Does nothing when DOPBASE_BIN points at another build. Exits on a failed
 * build. Quiet mode prints one line per build instead of the build output.
 */
export function ensureBinary(quiet: boolean): void {
  if (process.env.DOPBASE_BIN) return;
  const binary = join(ROOT, "app/target/release/dopbase");
  const uiIndex = join(ROOT, "ui/dist/index.html");
  const uiSources = Math.max(
    newestMtime(join(ROOT, "ui/src")),
    newestMtime(join(ROOT, "ui/public")),
    newestMtime(join(ROOT, "ui/index.html")),
  );
  const uiStale = uiSources > newestMtime(uiIndex) || !existsSync(uiIndex);
  if (uiStale) {
    if (quiet) console.log("Building the Admin UI (its sources changed)…");
    if (run("bun", ["run", "build:ui"], quiet) !== 0) process.exit(1);
  }
  const sources = Math.max(
    newestMtime(join(ROOT, "app/src")),
    newestMtime(join(ROOT, "app/migrations")),
    newestMtime(join(ROOT, "app/Cargo.toml")),
    newestMtime(join(ROOT, "app/Cargo.lock")),
    newestMtime(join(ROOT, "ui/dist")),
  );
  if (!existsSync(binary) || sources > statSync(binary).mtimeMs) {
    if (quiet) console.log("Building the release binary (sources changed)…");
    if (run("bun", ["run", "build:app"], quiet) !== 0) process.exit(1);
  }
}
