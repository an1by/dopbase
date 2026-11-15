// Runs every test layer in order and stops at the first one that fails:
// format, lint, typecheck, UI unit tests, Rust tests, then the e2e suites.
// Each layer's result goes to .e2e/unit.json so the e2e report can show it.
//
//   bun run test [-- <args for test:e2e, e.g. --agent>]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".e2e");

type Layer = { name: string; command: string; args: string[] };
type Result = {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
};

const e2eArgs = process.argv.slice(2).filter((arg) => arg !== "--");

const LAYERS: Layer[] = [
  {
    name: "Format",
    command: "bun run format:check",
    args: ["run", "format:check"],
  },
  { name: "Lint", command: "bun run lint", args: ["run", "lint"] },
  {
    name: "Typecheck",
    command: "bun run typecheck",
    args: ["run", "typecheck"],
  },
  { name: "UI unit", command: "bun run test:ui", args: ["run", "test:ui"] },
  { name: "Rust unit", command: "bun run test:app", args: ["run", "test:app"] },
];

const results: Result[] = LAYERS.map((layer) => ({
  name: layer.name,
  command: layer.command,
  status: "skipped",
  durationMs: 0,
}));

function save(): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "unit.json"),
    JSON.stringify({ layers: results }, null, 2),
  );
}

for (const [index, layer] of LAYERS.entries()) {
  console.log(`\n▶ ${layer.name}: ${layer.command}`);
  const started = Date.now();
  const { status } = spawnSync("bun", layer.args, {
    cwd: ROOT,
    stdio: "inherit",
  });
  results[index] = {
    name: layer.name,
    command: layer.command,
    status: status === 0 ? "passed" : "failed",
    durationMs: Date.now() - started,
  };
  save();
  if (status !== 0) {
    console.error(`\n✗ ${layer.name} failed; later layers were not run.`);
    process.exit(status ?? 1);
  }
}

console.log("\n▶ E2E: bun run test:e2e");
const { status } = spawnSync("bun", ["run", "test:e2e", ...e2eArgs], {
  cwd: ROOT,
  stdio: "inherit",
  // Tells e2e/run.ts to keep the unit.json written above.
  env: { ...process.env, E2E_FROM_TEST_ALL: "1" },
});
process.exit(status ?? 1);
