import { readFileSync } from "node:fs";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { runCli } from "../harness/server.ts";
import { Instance } from "./support.ts";

const app = useServer();
const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

// The commands listed under "Commands:" in a help page.
function subcommands(help: string): string[] {
  const names: string[] = [];
  let inCommands = false;
  for (const line of help.split("\n")) {
    if (line === "Commands:") {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (line.trim() === "") break;
    const name = line.match(/^ {2}([a-z][a-z0-9-]*)\s/)?.[1];
    if (name) names.push(name);
  }
  return names;
}

test(
  "every command in the help tree parses",
  {
    tag: "@smoke",
    annotation: about(
      "Walks `dopbase --help` and `dopbase help <command>` down to every leaf and fails on any command path that errors.",
    ),
  },
  async () => {
    // runCli, not app.cli: asking for help is not a test of the command, so
    // the walk must not count toward coverage.
    const visited: string[] = [];
    const failures: string[] = [];
    const walk = async (path: string[]): Promise<void> => {
      const help = await runCli([...path, "--help"]);
      const viaHelp = await runCli(["help", ...path]);
      visited.push(path.join(" ") || "(root)");
      if (help.code !== 0) failures.push(`dopbase ${path.join(" ")} --help`);
      if (viaHelp.code !== 0) failures.push(`dopbase help ${path.join(" ")}`);
      for (const name of subcommands(help.stdout)) {
        if (name === "help") {
          const nested = await runCli(["help", ...path, "help"]);
          if (nested.code !== 0)
            failures.push(`dopbase help ${path.join(" ")} help`);
          continue;
        }
        await walk([...path, name]);
      }
    };

    await step(
      "dopbase --help, then dopbase <command> --help and dopbase help <command> for every command",
      async () => {
        await walk([]);
      },
    );
    await step("Every help page exits 0", async () => {
      await test.info().attach("command paths", {
        body: visited.join("\n"),
        contentType: "text/plain",
      });
      expect(failures).toEqual([]);
    });
    await step(
      "The walk reaches the leaf commands, e.g. secret rollback and token personal revoke",
      async () => {
        expect(visited.length).toBeGreaterThan(50);
        expect(visited).toContain("secret rollback");
        expect(visited).toContain("token personal revoke");
        expect(visited).toContain("server logs");
      },
    );
  },
);

test(
  "prints the release version",
  {
    tag: "@smoke",
    annotation: about(
      "`dopbase --version` and `-V` print v plus the version in package.json.",
    ),
  },
  async () => {
    await step("dopbase --version prints v" + pkg.version, async () => {
      expect(await app.cliRaw(["--version"]).stdout()).toBe(`v${pkg.version}`);
    });
    await step("dopbase -V prints the same", async () => {
      expect(await app.cliRaw(["-V"]).stdout()).toBe(`v${pkg.version}`);
    });
  },
);

test(
  "removed server commands fail and point to their replacements",
  {
    tag: "@smoke",
    annotation: about(
      "`dopbase server down` and `server up` were replaced; both exit 1, name the new command and touch no server.",
    ),
  },
  async () => {
    const instance = await Instance.create(app, "removed");
    const down = await step("dopbase server down", async () =>
      instance.cli(["server", "down"]).fails(1),
    );
    await step("It names dopbase server stop", async () => {
      expect(down.stderr).toContain("dopbase server stop");
      expect(down.stderr).toContain("No server was stopped.");
    });
    const json = await step("dopbase --json server down", async () =>
      instance.cli(["--json", "server", "down"]).fails(1),
    );
    await step("The JSON says COMMAND_REPLACED", async () => {
      const body = JSON.parse(json.stdout);
      expect(body.success).toBe(false);
      expect(body.info.code).toBe("COMMAND_REPLACED");
      expect(body.info.replacement).toBe("dopbase server stop");
    });
    const up = await step("dopbase server up", async () =>
      instance.cli(["server", "up"]).fails(1),
    );
    await step("It names dopbase server start --background", async () => {
      expect(up.stderr).toContain("dopbase server start --background");
      expect(up.stderr).toContain("No server was started.");
    });
  },
);

test(
  "an unknown command fails with a usage error",
  {
    tag: "@smoke",
    annotation: about(
      "A command that doesn't exist exits 2 with a usage error that names it.",
    ),
  },
  async () => {
    const result = await step("dopbase secrets list", async () =>
      app.cliRaw(["secrets", "list"]).fails(2),
    );
    await step("The error names the unknown subcommand", async () => {
      expect(result.stderr).toContain("unrecognized subcommand 'secrets'");
    });
  },
);
