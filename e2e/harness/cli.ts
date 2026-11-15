// Runs the CLI for a test: records the coverage hit, attaches the output to
// the test, and checks list-style output for leaked secret values.
import { expect, test } from "@playwright/test";
import { runCli, type CliResult, type RunOptions } from "./server.ts";
import { recordHit } from "./record.ts";
import { commandWords } from "./words.ts";

export { commandWords };

// Commands whose output must never contain a secret value.
const LEAK_CHECKED = [
  /^secret (list|history)\b/,
  /^audit (list|export)\b/,
  /^(project|env) (list|show)\b/,
];

const MAX_ATTACHED = 4_000;

function clip(text: string): string {
  return text.length > MAX_ATTACHED
    ? `${text.slice(0, MAX_ATTACHED)}\n… ${text.length - MAX_ATTACHED} more characters`
    : text;
}

/** A CLI call. Await it for the raw result, or use one of the helpers. */
export class CliRun implements PromiseLike<CliResult> {
  readonly args: string[];
  private readonly result: Promise<CliResult>;

  constructor(
    args: string[],
    opts: RunOptions,
    secrets: () => Iterable<string>,
    env?: Promise<Record<string, string>>,
  ) {
    this.args = args;
    if (opts.record !== false) recordHit("cli", args.join(" "));
    const started = env
      ? env.then((resolved) => runCli(args, { ...opts, env: resolved }))
      : runCli(args, opts);
    this.result = started.then(async (result) => {
      const words = commandWords(args).join(" ");
      if (LEAK_CHECKED.some((pattern) => pattern.test(words))) {
        for (const value of secrets()) {
          if (result.stdout.includes(value) || result.stderr.includes(value)) {
            throw new Error(
              `\`dopbase ${words}\` printed a secret value; list output must never show values`,
            );
          }
        }
      }
      try {
        await test.info().attach(`cli: dopbase ${args.join(" ")}`, {
          body: `$ dopbase ${args.join(" ")}\nexit ${result.code}\n\n--- stdout\n${clip(result.stdout)}\n--- stderr\n${clip(result.stderr)}`,
          contentType: "text/plain",
        });
      } catch {
        // Outside a test: nothing to attach to.
      }
      return result;
    });
  }

  then<A = CliResult, B = never>(
    onfulfilled?: ((value: CliResult) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.result.then(onfulfilled, onrejected);
  }

  /** Asserts exit code 0 and returns the result. */
  async ok(): Promise<CliResult> {
    const result = await this.result;
    expect(
      result.code,
      `dopbase ${this.args.join(" ")} should exit 0\n${result.stderr}`,
    ).toBe(0);
    return result;
  }

  /** Asserts a non-zero exit (or exactly `code`) and returns the result. */
  async fails(code?: number): Promise<CliResult> {
    const result = await this.result;
    if (code === undefined) {
      expect(
        result.code,
        `dopbase ${this.args.join(" ")} should fail\n${result.stdout}`,
      ).not.toBe(0);
    } else {
      expect(result.code).toBe(code);
    }
    return result;
  }

  /** Asserts success and returns trimmed standard output. */
  async stdout(): Promise<string> {
    return (await this.ok()).stdout.trim();
  }

  /** Asserts success and parses standard output as JSON. */
  async json<T = any>(): Promise<T> {
    const out = await this.stdout();
    try {
      return JSON.parse(out) as T;
    } catch {
      throw new Error(
        `dopbase ${this.args.join(" ")} did not print JSON:\n${out}`,
      );
    }
  }
}
