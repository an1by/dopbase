// Writes every test of a run, in the same shape for all four suites, to
// .e2e/last-run.json. The coverage check, the HTML report and the agent
// summary all read that one file, so they can't disagree.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";
import { DESCRIPTION_ANNOTATION, HIT_ANNOTATION } from "./record.ts";

export type StepData = {
  title: string;
  durationMs: number;
  status: "passed" | "failed";
  error?: string;
  /** Path of the screenshot step() attached, relative to the repo root. */
  screenshot?: string;
  steps: StepData[];
};

export type AttachmentData = {
  name: string;
  contentType: string;
  /** Path relative to the repo root, when the attachment is a file. */
  path?: string;
  /** Inline text for small text attachments. */
  text?: string;
};

export type TestData = {
  id: string;
  project: string;
  file: string;
  line: number;
  title: string;
  titlePath: string[];
  tags: string[];
  description?: string;
  /** e.g. `cli secret set billing/dev API_KEY`, `api GET /api/v1/health`, `ui /projects`. */
  hits: string[];
  /** passed, failed, flaky or skipped. */
  status: "passed" | "failed" | "flaky" | "skipped";
  durationMs: number;
  retries: number;
  error?: { message: string; stack?: string; location?: string };
  failedStep?: string;
  steps: StepData[];
  attachments: AttachmentData[];
};

export type RunData = {
  meta: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    status: string;
    version: string;
    branch: string;
    commit: string;
    binary: string;
    projects: string[];
    grep?: string;
    workers: number;
  };
  tests: TestData[];
  errors: string[];
};

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const TEXT_LIMIT = 20_000;

function git(args: string[], fallback: string): string {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return fallback;
  }
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function slug(text: string): string {
  return text
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .toLowerCase();
}

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "video/webm": ".webm",
  "application/json": ".json",
  "application/zip": ".zip",
  "text/plain": ".txt",
};

export default class E2eReporter implements Reporter {
  private readonly outputFile: string;
  private readonly attachmentsDir: string;
  private config?: FullConfig;
  private projects: string[] = [];
  private startedAt = new Date();
  private readonly tests = new Map<string, TestData>();
  private readonly errors: string[] = [];

  constructor(options: { outputFile?: string } = {}) {
    this.outputFile = resolve(
      import.meta.dirname,
      "..",
      options.outputFile ?? "../.e2e/last-run.json",
    );
    this.attachmentsDir = join(
      dirname(this.outputFile),
      "results",
      "attachments",
    );
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    // Only the projects this run includes (after --project filtering).
    this.projects = suite.suites
      .filter((project) => project.allTests().length > 0)
      .map((project) => project.title);
    this.startedAt = new Date();
  }

  onError(error: { message?: string; stack?: string }): void {
    this.errors.push(stripAnsi(error.stack ?? error.message ?? String(error)));
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const outcome = test.outcome();
    const status: TestData["status"] =
      outcome === "skipped"
        ? "skipped"
        : outcome === "flaky"
          ? "flaky"
          : outcome === "expected"
            ? "passed"
            : "failed";
    const attachments = this.saveAttachments(test, result);
    const screenshots = new Map(
      attachments
        .filter((a) => a.name.startsWith("screenshot: ") && a.path)
        .map((a) => [a.name.slice("screenshot: ".length), a.path!]),
    );
    const steps = result.steps
      .flatMap((step) => this.collectSteps(step, screenshots))
      .filter((step): step is StepData => step !== undefined);
    const error = result.errors[0] ?? result.error;
    const project = test.parent.project()?.name ?? "";

    this.tests.set(test.id, {
      id: test.id,
      project,
      file: relative(REPO_ROOT, test.location.file),
      line: test.location.line,
      title: test.title,
      titlePath: test.titlePath().filter(Boolean).slice(2),
      tags: test.tags,
      description: test.annotations.find(
        (a) => a.type === DESCRIPTION_ANNOTATION,
      )?.description,
      hits: [
        ...new Set(
          [...test.annotations, ...result.annotations]
            .filter((a) => a.type === HIT_ANNOTATION && a.description)
            .map((a) => a.description!),
        ),
      ],
      status,
      durationMs: result.duration,
      retries: result.retry,
      error: error
        ? {
            message: stripAnsi(error.message ?? String(error.value ?? "")),
            stack: error.stack ? stripAnsi(error.stack) : undefined,
            location: error.location
              ? `${relative(REPO_ROOT, error.location.file)}:${error.location.line}`
              : undefined,
          }
        : undefined,
      failedStep: this.findFailedStep(steps),
      steps,
      attachments,
    });
  }

  private collectSteps(
    step: TestStep,
    screenshots: Map<string, string>,
  ): StepData[] {
    const children = step.steps.flatMap((child) =>
      this.collectSteps(child, screenshots),
    );
    if (step.category !== "test.step") return children;
    return [
      {
        title: step.title,
        durationMs: step.duration,
        status: step.error ? "failed" : "passed",
        error: step.error?.message ? stripAnsi(step.error.message) : undefined,
        screenshot: screenshots.get(step.title),
        steps: children,
      },
    ];
  }

  private findFailedStep(steps: StepData[]): string | undefined {
    for (const step of steps) {
      if (step.status === "failed")
        return this.findFailedStep(step.steps) ?? step.title;
    }
    return undefined;
  }

  private saveAttachments(
    test: TestCase,
    result: TestResult,
  ): AttachmentData[] {
    const saved: AttachmentData[] = [];
    result.attachments.forEach((attachment, index) => {
      const data: AttachmentData = {
        name: attachment.name,
        contentType: attachment.contentType,
      };
      if (attachment.path) {
        data.path = relative(REPO_ROOT, attachment.path);
      } else if (attachment.body) {
        const isText =
          attachment.contentType.startsWith("text/") ||
          attachment.contentType === "application/json";
        if (isText && attachment.body.length <= TEXT_LIMIT) {
          data.text = attachment.body.toString("utf8");
        } else {
          const dir = join(
            this.attachmentsDir,
            `${slug(test.title)}-${test.id.slice(0, 8)}`,
          );
          mkdirSync(dir, { recursive: true });
          const file = join(
            dir,
            `${index}-${slug(attachment.name) || "attachment"}${EXT[attachment.contentType] ?? extname(attachment.name)}`,
          );
          writeFileSync(file, new Uint8Array(attachment.body));
          data.path = relative(REPO_ROOT, file);
        }
      }
      saved.push(data);
    });
    return saved;
  }

  onEnd(result: FullResult): void {
    const finishedAt = new Date();
    let version = "unknown";
    try {
      version = JSON.parse(
        readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
      ).version;
    } catch {
      // Keep unknown.
    }
    const data: RunData = {
      meta: {
        startedAt: this.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - this.startedAt.getTime(),
        status: result.status,
        version,
        branch:
          process.env.GIT_BRANCH ??
          git(["rev-parse", "--abbrev-ref", "HEAD"], "unknown"),
        commit:
          process.env.GIT_COMMIT ??
          git(["rev-parse", "--short", "HEAD"], "unknown"),
        binary: process.env.DOPBASE_BIN ?? "app/target/release/dopbase",
        projects: this.projects,
        grep: process.env.E2E_GREP,
        workers: this.config?.workers ?? 1,
      },
      tests: [...this.tests.values()],
      errors: this.errors,
    };
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, JSON.stringify(data, null, 2));
  }

  // In agent mode this reporter "owns" stdout (and prints nothing), so
  // Playwright doesn't add its own progress reporter; e2e/run.ts prints the
  // short summary instead.
  printsToStdio(): boolean {
    return Boolean(process.env.E2E_AGENT);
  }
}
