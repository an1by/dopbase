// Runs the e2e suites: rebuilds the release binary when it is stale, runs
// Playwright, checks coverage, writes the HTML report and, with --agent,
// prints a short summary instead of the full test list.
//
//   bun run test:e2e [--agent] [--project cli|api|ui|journeys]... [--grep TEXT]
//                    [--skip-build] [--keep] [--open] [-- <extra playwright args>]
//   bun run test:e2e:report      open the last report
//   bun run test:e2e:help        every test script, flag and tag
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkCoverage,
  printCoverage,
  type CoverageData,
} from "./coverage/check.ts";
import type { RunData, TestData } from "./harness/reporter.ts";
import { ensureBinary } from "./binary.ts";
import { printHelp } from "./help.ts";
import { buildReport } from "./report/build.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".e2e");
const ALL_PROJECTS = ["cli", "api", "ui", "journeys"];

type Args = {
  agent: boolean;
  keep: boolean;
  skipBuild: boolean;
  open: boolean;
  openOnly: boolean;
  help: boolean;
  projects: string[];
  grep?: string;
  extra: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    agent: false,
    keep: false,
    skipBuild: false,
    open: false,
    openOnly: false,
    help: false,
    projects: [],
    extra: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      args.extra.push(...argv.slice(i + 1));
      break;
    } else if (arg === "--agent") args.agent = true;
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--skip-build") args.skipBuild = true;
    else if (arg === "--open") args.open = true;
    else if (arg === "--open-report") args.openOnly = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--project") args.projects.push(argv[++i]!);
    else if (arg.startsWith("--project="))
      args.projects.push(arg.slice("--project=".length));
    else if (arg === "--grep" || arg === "-g") args.grep = argv[++i];
    else if (arg.startsWith("--grep=")) args.grep = arg.slice("--grep=".length);
    else args.extra.push(arg);
  }
  return args;
}

function clean(): void {
  const names = [
    "results",
    "playwright",
    "report",
    "last-run.json",
    "coverage.json",
  ];
  // bun run test writes unit.json right before it starts this run. In any other
  // run it is left over from an earlier full run and would show old results.
  if (!process.env.E2E_FROM_TEST_ALL) names.push("unit.json");
  for (const name of names) {
    rmSync(join(OUT, name), { recursive: true, force: true });
  }
}

function suiteLine(label: string, tests: TestData[]): string {
  const n = (status: TestData["status"]) =>
    tests.filter((t) => t.status === status).length;
  const parts = [`${n("passed")} passed`];
  if (n("failed")) parts.push(`${n("failed")} failed`);
  if (n("flaky")) parts.push(`${n("flaky")} flaky`);
  if (n("skipped")) parts.push(`${n("skipped")} skipped`);
  return `${label.padEnd(10)}${parts.join(", ")}`;
}

function firstLines(text: string, count: number): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, count)
    .map((line) => `  ${line}`)
    .join("\n");
}

/** The short summary for agents: one line per suite, then each failure. */
function printAgentSummary(
  data: RunData,
  coverage: CoverageData | undefined,
  report: string,
): void {
  const labels: Record<string, string> = {
    cli: "CLI",
    api: "API",
    ui: "UI",
    journeys: "JOURNEYS",
  };
  for (const project of ALL_PROJECTS) {
    const tests = data.tests.filter((t) => t.project === project);
    if (tests.length) console.log(suiteLine(labels[project]!, tests));
  }
  if (coverage) {
    const ran = coverage.surfaces.filter((s) => s.ran);
    const parts = ran.map(
      (s) => `${s.kind} ${s.covered + s.skipped}/${s.total}`,
    );
    const missing = ran.reduce((n, s) => n + s.missing, 0);
    if (!parts.length) parts.push("no cli, api or ui suite in this run");
    const state = coverage.passed
      ? missing
        ? `report only, ${missing} missing`
        : "ok"
      : "FAIL";
    console.log(`${"COVERAGE".padEnd(10)}${state} (${parts.join(", ")})`);
    if (!coverage.passed) printCoverage(coverage, { listMissing: 10 });
  }
  for (const error of data.errors)
    console.log(`\n✗ ${firstLines(error, 4).trim()}`);

  const failures = data.tests.filter((t) => t.status === "failed");
  for (const test of failures.slice(0, 10)) {
    console.log(`\n✗ ${test.file.replace(/^e2e\//, "")} › ${test.title}`);
    if (test.failedStep) console.log(`  step: ${test.failedStep}`);
    if (test.error) console.log(firstLines(test.error.message, 4));
    // Trace first: it holds everything. Then the screenshot and video.
    const rank = (name: string) =>
      ["trace", "screenshot", "video"].indexOf(name) >>> 0;
    const seen = new Set<string>();
    const files = test.attachments
      .filter((a) => a.path && !a.name.startsWith("screenshot: "))
      .filter((a) => !seen.has(a.path!) && seen.add(a.path!))
      .sort((a, b) => rank(a.name) - rank(b.name));
    for (const file of files.slice(0, 3))
      console.log(`  ${file.name}: ${file.path}`);
    if (test.attachments.some((a) => a.name === "server.log")) {
      console.log("  server.log: in the report's Failures tab");
    }
    const kept = test.attachments.find((a) => a.name === "kept server");
    const again = kept?.text?.split("\n").find((l) => l.includes("--from"));
    if (again) console.log(`  look around: ${again.trim()}`);
    // --grep is a regex and the shell would expand $ and backticks, so
    // escape the title for both.
    const pattern = test.title
      .slice(0, 60)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/'/g, "'\\''");
    console.log(
      `  rerun: bun run test:e2e --project ${test.project} --grep '${pattern}'`,
    );
  }
  if (failures.length > 10)
    console.log(`\n… ${failures.length - 10} more failures in the report`);
  const flaky = data.tests.filter((t) => t.status === "flaky");
  for (const test of flaky)
    console.log(`~ flaky: ${test.file.replace(/^e2e\//, "")} › ${test.title}`);
  console.log(`\nreport: ${relative(ROOT, report)}`);
}

function openFile(file: string): void {
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  spawnSync(opener, [file], { stdio: "ignore" });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const reportFile = join(OUT, "report", "index.html");

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.openOnly) {
    if (!existsSync(reportFile)) {
      console.error("No report yet. Run bun run test:e2e first.");
      return 1;
    }
    openFile(reportFile);
    console.log(pathToFileURL(reportFile).href);
    return 0;
  }

  if (!args.skipBuild) ensureBinary(args.agent);
  clean();

  const playwrightArgs = [
    "test",
    ...args.projects.map((p) => `--project=${p}`),
  ];
  if (args.grep) playwrightArgs.push("--grep", args.grep);
  playwrightArgs.push(...args.extra);
  const env: Record<string, string> = {};
  if (args.agent) env.E2E_AGENT = "1";
  if (args.keep) env.E2E_KEEP = "1";
  if (args.grep) env.E2E_GREP = args.grep;
  const testExit = spawnSync(
    join(ROOT, "e2e/node_modules/.bin/playwright"),
    playwrightArgs,
    {
      cwd: join(ROOT, "e2e"),
      stdio: "inherit",
      env: { ...process.env, ...env },
    },
  ).status;

  const runFile = join(OUT, "last-run.json");
  if (!existsSync(runFile)) {
    console.error("Playwright wrote no results; see the output above.");
    return testExit ?? 1;
  }
  const data = JSON.parse(readFileSync(runFile, "utf8")) as RunData;

  const fullRun =
    !args.grep &&
    args.extra.length === 0 &&
    (args.projects.length === 0 ||
      ALL_PROJECTS.every((p) => args.projects.includes(p)));
  let coverage: CoverageData | undefined;
  try {
    coverage = await checkCoverage(fullRun);
    if (!args.agent) printCoverage(coverage);
  } catch (error) {
    console.error(`Coverage check failed to run: ${String(error)}`);
  }

  const report = buildReport();
  if (args.agent) printAgentSummary(data, coverage, report);
  else console.log(`\nReport: ${pathToFileURL(report).href}`);
  if (args.open) openFile(report);

  if (testExit !== 0) return testExit ?? 1;
  // Report-only mode allows missing entries, not a check that never ran.
  if (fullRun && !coverage) return 1;
  if (coverage && !coverage.passed) return 1;
  return 0;
}

process.exit(await main());
