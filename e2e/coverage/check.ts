// Checks that every CLI command, API route and Admin UI page has an e2e test
// in its own suite, and that every test reads as a scenario (a description
// and at least one named step). Reads .e2e/last-run.json, writes
// .e2e/coverage.json and prints a table.
//
//   bun e2e/coverage/check.ts            report only
//   bun e2e/coverage/check.ts --full     the run included every suite; strict
//                                        mode in manifest.ts can now fail it
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunData, TestData } from "../harness/reporter.ts";
import { runCli, startServer } from "../harness/server.ts";
import { commandWords } from "../harness/words.ts";
import { skip, strict } from "./manifest.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, ".e2e");

export type EntryStatus = "covered" | "skipped" | "missing";
export type Entry = {
  id: string;
  status: EntryStatus;
  tests: string[];
  reason?: string;
};
export type Surface = {
  kind: "cli" | "api" | "ui";
  label: string;
  total: number;
  covered: number;
  skipped: number;
  missing: number;
  /** Whether the run included this surface's own suite. Hits only count
   * there, so without it every entry reads as missing. */
  ran: boolean;
  entries: Entry[];
};
export type CoverageData = {
  mode: "strict" | "report";
  fullRun: boolean;
  passed: boolean;
  surfaces: Surface[];
  /** Tests without a description or without named steps. */
  unexplained: { test: string; lacks: string[] }[];
  /** Skip entries in manifest.ts that match nothing any more. */
  staleSkips: string[];
};

/** Every leaf command, found by walking `dopbase help`. */
async function cliCommands(): Promise<string[]> {
  const leaves: string[] = [];
  const walk = async (path: string[]) => {
    const { stdout, code } = await runCli([...path, "--help"]);
    if (code !== 0)
      throw new Error(`dopbase ${path.join(" ")} --help exited ${code}`);
    const subcommands: string[] = [];
    let inCommands = false;
    for (const line of stdout.split("\n")) {
      if (line.trim() === "Commands:") {
        inCommands = true;
        continue;
      }
      if (inCommands) {
        const match = line.match(/^ {2}(\S+)\s{2,}/);
        if (!match) {
          if (line.trim() === "" || /^\S/.test(line)) inCommands = false;
          continue;
        }
        if (match[1] !== "help") subcommands.push(match[1]!);
      }
    }
    if (!subcommands.length && path.length) leaves.push(path.join(" "));
    for (const sub of subcommands) await walk([...path, sub]);
  };
  await walk([]);
  return leaves.sort();
}

/** Every `METHOD /path` in the server's OpenAPI document. */
async function apiRoutes(): Promise<string[]> {
  const server = await startServer({ claimRoot: false, docs: true });
  try {
    const doc = (await (
      await fetch(`${server.url}/api/v1/openapi.json`)
    ).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const methods = ["get", "post", "put", "patch", "delete"];
    return Object.entries(doc.paths)
      .flatMap(([path, ops]) =>
        Object.keys(ops)
          .filter((m) => methods.includes(m))
          .map((m) => `${m.toUpperCase()} ${path}`),
      )
      .sort();
  } finally {
    await server.stop();
  }
}

/** Every page in ui/src/router.ts, without the redirect from / and the catch-all. */
function uiPages(): string[] {
  const source = readFileSync(join(ROOT, "ui/src/router.ts"), "utf8");
  const paths = [...source.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]!);
  return [...new Set(paths)]
    .filter((p) => p !== "/" && !p.includes("pathMatch"))
    .sort();
}

// --- matching hits to entries ---------------------------------------------

function staticSegments(pattern: string): number {
  return pattern
    .split("/")
    .filter((s) => s && !s.startsWith(":") && !s.startsWith("{")).length;
}

function apiRegex(template: string): RegExp {
  const [method, path] = template.split(" ");
  const body = path!
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\\?\{[^}]+\\?\}/g, "[^/]+")
    .replace(/\{[^}]+\}/g, "[^/]+");
  return new RegExp(`^${method} ${body}/?$`);
}

function uiRegex(pattern: string): RegExp {
  // One segment at a time: `:id`, `:id?`, `:tail(a|b)` and `:tail(a|b)?`.
  const body = pattern
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const param = segment.match(/^:\w+(?:\(([^)]+)\))?(\?)?$/);
      if (!param) return `/${segment.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}`;
      const value = param[1] ? `(?:${param[1]})` : "[^/]+";
      return param[2] ? `(?:/${value})?` : `/${value}`;
    })
    .join("");
  return new RegExp(`^${body}/?$`);
}

/** The most specific entry a value matches. */
function bestMatch(
  value: string,
  entries: { id: string; regex: RegExp }[],
): string | undefined {
  const matches = entries.filter((e) => e.regex.test(value));
  matches.sort((a, b) => staticSegments(b.id) - staticSegments(a.id));
  return matches[0]?.id;
}

function testName(test: TestData): string {
  return `${test.file.replace(/^e2e\//, "")} › ${test.title}`;
}

function surface(
  kind: Surface["kind"],
  label: string,
  ids: string[],
  hitsById: Map<string, Set<string>>,
): Omit<Surface, "ran"> {
  const entries: Entry[] = ids.map((id) => {
    const tests = [...(hitsById.get(id) ?? [])];
    const reason = skip[`${kind} ${id}`];
    if (tests.length) return { id, status: "covered", tests };
    if (reason) return { id, status: "skipped", tests, reason };
    return { id, status: "missing", tests };
  });
  const count = (status: EntryStatus) =>
    entries.filter((e) => e.status === status).length;
  return {
    kind,
    label,
    total: entries.length,
    covered: count("covered"),
    skipped: count("skipped"),
    missing: count("missing"),
    entries,
  };
}

export async function checkCoverage(fullRun: boolean): Promise<CoverageData> {
  const runFile = join(OUT, "last-run.json");
  if (!existsSync(runFile))
    throw new Error("No .e2e/last-run.json; run the e2e suites first");
  const run = JSON.parse(readFileSync(runFile, "utf8")) as RunData;

  const [cli, api] = await Promise.all([cliCommands(), apiRoutes()]);
  const ui = uiPages();

  const cliSet = new Set(cli);
  const apiEntries = api.map((id) => ({ id, regex: apiRegex(id) }));
  const uiEntries = ui.map((id) => ({ id, regex: uiRegex(id) }));
  const hits = {
    cli: new Map<string, Set<string>>(),
    api: new Map(),
    ui: new Map(),
  } as Record<Surface["kind"], Map<string, Set<string>>>;
  const add = (
    kind: Surface["kind"],
    id: string | undefined,
    test: TestData,
  ) => {
    if (!id) return;
    const set = hits[kind].get(id) ?? new Set<string>();
    set.add(testName(test));
    hits[kind].set(id, set);
  };

  for (const test of run.tests) {
    if (test.status === "skipped") continue;
    for (const hit of test.hits) {
      const space = hit.indexOf(" ");
      const kind = hit.slice(0, space) as Surface["kind"];
      const value = hit.slice(space + 1);
      // A hit only counts in its own suite: CLI commands from cli/, routes
      // from api/, pages from ui/.
      if (kind !== test.project) continue;
      if (kind === "cli") {
        const words = commandWords(value.split(" "));
        for (let n = words.length; n > 0; n--) {
          const candidate = words.slice(0, n).join(" ");
          if (cliSet.has(candidate)) {
            add("cli", candidate, test);
            break;
          }
        }
      } else if (kind === "api") {
        add("api", bestMatch(value, apiEntries), test);
      } else if (kind === "ui") {
        add("ui", bestMatch(value, uiEntries), test);
      }
    }
  }

  const surfaces = [
    surface("cli", "CLI commands", cli, hits.cli),
    surface("api", "API routes", api, hits.api),
    surface("ui", "UI pages", ui, hits.ui),
  ].map((s) => ({
    ...s,
    ran: run.tests.some((t) => t.project === s.kind && t.status !== "skipped"),
  }));

  const unexplained = run.tests
    .filter((t) => t.status !== "skipped")
    .map((t) => ({
      test: testName(t),
      lacks: [
        ...(t.description ? [] : ["description"]),
        ...(t.steps.length ? [] : ["steps"]),
      ],
    }))
    .filter((t) => t.lacks.length);

  const known = new Set(
    surfaces.flatMap((s) => s.entries.map((e) => `${s.kind} ${e.id}`)),
  );
  const staleSkips = Object.keys(skip).filter((key) => !known.has(key));

  const mode = strict && fullRun ? "strict" : "report";
  const missing = surfaces.reduce((n, s) => n + s.missing, 0);
  const passed =
    mode === "report" || (missing === 0 && unexplained.length === 0);

  const data: CoverageData = {
    mode,
    fullRun,
    passed,
    surfaces,
    unexplained,
    staleSkips,
  };
  writeFileSync(join(OUT, "coverage.json"), JSON.stringify(data, null, 2));
  return data;
}

export function printCoverage(
  data: CoverageData,
  opts: { listMissing?: number } = {},
): void {
  const limit = opts.listMissing ?? 20;
  console.log(`Coverage (${data.mode}${data.fullRun ? "" : ", partial run"})`);
  for (const s of data.surfaces) {
    // `ran` is missing from a coverage.json written before it existed.
    if (s.ran === false) {
      console.log(
        `  ${s.label.padEnd(13)} not checked: the ${s.kind} suite wasn't in this run`,
      );
      continue;
    }
    const skipped = s.skipped ? `, ${s.skipped} skipped` : "";
    console.log(
      `  ${s.label.padEnd(13)} ${s.covered + s.skipped}/${s.total}${skipped}`,
    );
    const missing = s.entries.filter((e) => e.status === "missing");
    for (const entry of missing.slice(0, limit))
      console.log(`    ✗ ${entry.id}`);
    if (missing.length > limit)
      console.log(`    … ${missing.length - limit} more`);
  }
  if (data.unexplained.length) {
    console.log(
      `  Tests without a description or steps: ${data.unexplained.length}`,
    );
    for (const t of data.unexplained.slice(0, limit)) {
      console.log(`    ✗ ${t.test} (no ${t.lacks.join(", no ")})`);
    }
  }
  for (const key of data.staleSkips)
    console.log(`  Stale skip in manifest.ts: ${key}`);
  if (!data.passed) console.log("FAIL: coverage is incomplete");
}

if (import.meta.main) {
  const full = process.argv.includes("--full");
  const data = await checkCoverage(full);
  printCoverage(data);
  process.exit(data.passed ? 0 : 1);
}
