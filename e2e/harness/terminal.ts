// A pseudo-terminal for CLI commands that refuse to run without one:
// password prompts, typed confirmations, the secret editor.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "@playwright/test";
import { binaryPath, cleanEnv } from "./server.ts";

/** Removes ANSI escape sequences, so pty output can be matched as text. */
export function plain(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r/g, "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type PtyStep = {
  /** Text to wait for in the output (ANSI codes are ignored). */
  wait: string | RegExp;
  /** What to type once it shows, e.g. "y\r" or "\x03" for Ctrl+C. */
  send: string;
};

export type PtyResult = { code: number | null; output: string };

/**
 * Runs `dopbase <args>` in a pseudo-terminal through `script(1)`, for
 * commands that refuse to run without one (password prompts, confirmations,
 * the secret editor). Each step waits for a prompt and types the answer.
 *
 * Commands run this way don't count toward coverage; every one of them also
 * has a plain `app.cli`/`app.cliRaw` call in its test.
 */
export async function pty(
  args: string[],
  opts: {
    env: Record<string, string>;
    steps?: PtyStep[];
    timeoutMs?: number;
  },
): Promise<PtyResult> {
  // script(1) refuses a socket or a FIFO as its input on macOS, and Node's
  // stdio is a socket, so keystrokes reach it through `cat |`. cat only ends
  // when its input closes, so script's exit code comes back as a marker
  // line, and seeing it closes the input.
  const inner = [binaryPath(), ...args].map(shellQuote).join(" ");
  // Linux script(1) runs the command through sh -c. exec replaces that
  // shell, so Ctrl+C reaches dopbase alone and its exit code comes back;
  // otherwise dash takes the SIGINT too and reports 130 whatever dopbase did.
  const scriptCommand =
    process.platform === "darwin"
      ? `script -q /dev/null ${inner}`
      : `script -qfec ${shellQuote(`exec ${inner}`)} /dev/null`;
  const run = `cat | { ${scriptCommand}; printf '\\n${EXIT_MARKER}%s\\n' "$?"; }`;
  // Its own process group, so a kill reaches cat and script too. Killing
  // only sh would leave them holding the pipes, and "close" would never come.
  const child = spawn("sh", ["-c", run], {
    env: cleanEnv({ TERM: "xterm-256color", ...opts.env }),
    detached: true,
  });
  let raw = "";
  let code: number | null = null;
  let exited = false;
  let closedYet = false;
  let timedOut = false;
  let waiter: (() => void) | undefined;
  const killGroup = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
  };
  const onData = (chunk: Buffer) => {
    raw += chunk.toString();
    // Wait for the newline printf ends with: a chunk can split the code.
    const marker = raw.match(new RegExp(`${EXIT_MARKER}(\\d+)\\r?\\n`));
    if (marker && !exited) {
      code = Number(marker[1]);
      raw = raw.slice(0, marker.index);
      exited = true;
      child.stdin.end();
    }
    waiter?.();
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const closed = once(child, "close").then(() => {
    closedYet = true;
    exited = true;
    waiter?.();
  });
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);

  let cursor = 0;
  try {
    for (const step of opts.steps ?? []) {
      await new Promise<void>((done, fail) => {
        const check = () => {
          const text = plain(raw).slice(cursor);
          let index = -1;
          let length = 0;
          if (typeof step.wait === "string") {
            index = text.indexOf(step.wait);
            length = step.wait.length;
          } else {
            const found = step.wait.exec(text);
            if (found) {
              index = found.index;
              length = found[0].length;
            }
          }
          if (index >= 0) {
            cursor += index + length;
            waiter = undefined;
            done();
          } else if (exited) {
            waiter = undefined;
            const why = timedOut
              ? `was still waiting after ${timeoutMs} ms for`
              : "exited before showing";
            fail(
              new Error(
                `dopbase ${args.join(" ")} ${why} ${String(step.wait)}:\n${plain(raw)}`,
              ),
            );
          }
        };
        waiter = check;
        check();
      });
      child.stdin.write(step.send);
    }
    await closed;
    if (timedOut) {
      throw new Error(
        `dopbase ${args.join(" ")} didn't finish within ${timeoutMs} ms:\n${plain(raw)}`,
      );
    }
    return { code, output: plain(raw) };
  } finally {
    clearTimeout(timer);
    if (!closedYet) {
      child.stdin.end();
      killGroup();
    }
    try {
      await test.info().attach(`pty: dopbase ${args.join(" ")}`, {
        body: plain(raw),
        contentType: "text/plain",
      });
    } catch {
      // Outside a test.
    }
  }
}

const EXIT_MARKER = "__dopbase_pty_exit__:";
