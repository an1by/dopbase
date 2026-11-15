// Deletes what test runs leave behind: the e2e report and results, unit test
// coverage, the Rust coverage build, and e2e and sandbox servers left in the
// temp folder. Source code is never touched (e2e/coverage/ is the coverage
// checker, not output), so only the paths listed here go.
//
//   bun run clean:test [--dry-run]
//
// Stop any test run or sandbox first: their servers live in the temp folder
// and go with the rest.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");

const TARGETS: [string, string][] = [
  [".e2e", "e2e report, traces, screenshots and videos"],
  ["ui/coverage", "UI unit test coverage"],
  ["app/target/llvm-cov", "Rust coverage report"],
  ["app/target/llvm-cov-target", "Rust coverage build"],
];

function size(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((n, entry) => n + size(join(path, entry)), 0);
}

function human(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

const found: { path: string; label: string }[] = [];
for (const [path, label] of TARGETS) {
  const full = join(ROOT, path);
  if (existsSync(full)) found.push({ path: full, label });
}
// A failed run with E2E_KEEP, a sandbox started with --keep, or a run that
// was killed leaves its server here.
const temp = tmpdir();
for (const entry of readdirSync(temp)) {
  if (entry.startsWith("dopbase-e2e-") || entry.startsWith("dopbase-sandbox-"))
    found.push({ path: join(temp, entry), label: "server left in temp" });
}

if (!found.length) {
  console.log("Nothing to clean.");
  process.exit(0);
}

let total = 0;
for (const { path, label } of found) {
  const bytes = size(path);
  total += bytes;
  const shown = path.startsWith(ROOT) ? relative(ROOT, path) : path;
  console.log(`  ${human(bytes).padStart(9)}  ${shown}  (${label})`);
  if (!dryRun) rmSync(path, { recursive: true, force: true });
}
console.log(
  dryRun
    ? `\nWould free ${human(total)}. Run without --dry-run to delete.`
    : `\nFreed ${human(total)}.`,
);
