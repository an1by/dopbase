import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { grant, tempDir } from "../harness/helpers.ts";
import {
  ROOT_PASSWORD,
  about,
  expect,
  step,
  test,
  useServer,
  type Environment,
} from "../harness/index.ts";
import { pty } from "../harness/terminal.ts";
import { injected, signedInEnv, writeTemp } from "./support.ts";

// Members and personal tokens need people management turned on.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

/**
 * A read-level personal token for a Member who was given read on `env`'s
 * project. Export with it needs no terminal.
 */
async function readerToken(env: Environment): Promise<Record<string, string>> {
  const member = await app.make.user({ role: "Member" });
  await grant(app, member, "read", { project: env.projectName });
  const created = await app
    .cli(
      [
        "--json",
        "token",
        "personal",
        "create",
        "--name",
        app.uniq("export"),
        "--level",
        "read",
        "--project",
        env.projectName,
      ],
      { as: member },
    )
    .json();
  return {
    ...app.server.cliEnv,
    DOPBASE_DATA_DIR: await tempDir(app, "reader"),
    DOPBASE_TOKEN: created.plaintextToken,
  };
}

test(
  "import reads dotenv, JSON, YAML and TOML",
  {
    tag: "@import",
    annotation: about(
      "`import` adds keys from each format, reports added and updated keys, and `--dry-run` previews without saving.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const values = {
      DOTENV_KEY: app.value(),
      JSON_KEY: app.value(),
      YAML_KEY: app.value(),
      TOML_KEY: app.value(),
    };
    const files = {
      ".env": `DOTENV_KEY=${values.DOTENV_KEY}\n`,
      "secrets.json": JSON.stringify({ JSON_KEY: values.JSON_KEY }),
      "secrets.yaml": `YAML_KEY: ${values.YAML_KEY}\n`,
      "secrets.toml": `TOML_KEY = "${values.TOML_KEY}"\n`,
    };
    for (const [name, contents] of Object.entries(files)) {
      const path = await writeTemp(app, name, contents);
      const result = await step(
        `dopbase --json import ${env.ref} ${name}`,
        async () => app.cli(["--json", "import", env.ref, path]).json(),
      );
      await step(`One key is added from ${name}`, async () => {
        expect(result.addedKeys).toHaveLength(1);
      });
    }
    await step("dopbase run sees every imported value", async () => {
      for (const [key, value] of Object.entries(values)) {
        expect(await injected(app, env.ref, key)).toBe(value);
      }
    });

    const changed = app.value();
    const update = await writeTemp(
      app,
      ".env",
      `DOTENV_KEY=${changed}\nNEW_KEY=${app.value()}\n`,
    );
    const preview = await step(
      `dopbase import ${env.ref} .env --dry-run`,
      async () => app.cli(["import", env.ref, update, "--dry-run"]).stdout(),
    );
    await step(
      "The dry run counts 1 added and 1 updated, saving nothing",
      async () => {
        expect(preview).toContain("Dry run complete. No changes were applied.");
        expect(preview).toMatch(/Added:\s+1/);
        expect(preview).toMatch(/Updated:\s+1/);
        expect(await injected(app, env.ref, "DOTENV_KEY")).toBe(
          values.DOTENV_KEY,
        );
      },
    );
    const applied = await step(`dopbase import ${env.ref} .env`, async () =>
      app.cli(["import", env.ref, update]).stdout(),
    );
    await step("It says Imported secrets with mode merge", async () => {
      expect(applied).toContain(`Imported secrets into ${env.ref}.`);
      expect(applied).toMatch(/Mode:\s+merge/);
      expect(await injected(app, env.ref, "DOTENV_KEY")).toBe(changed);
    });

    const replace = await writeTemp(app, ".env", `ONLY_KEY=${app.value()}\n`);
    const unconfirmed = await step(
      `dopbase import ${env.ref} .env --replace without --yes`,
      async () => app.cli(["import", env.ref, replace, "--replace"]).fails(1),
    );
    await step(
      "Replace warns which keys it deletes and asks for --yes",
      async () => {
        expect(unconfirmed.stderr).toContain("Replace will delete:");
        expect(unconfirmed.stderr).toContain("Pass --yes");
      },
    );
    await step(`dopbase import ${env.ref} .env --replace --yes`, async () => {
      await app.cli(["import", env.ref, replace, "--replace", "--yes"]).ok();
      const keys = await app
        .cli(["--json", "secret", "list", env.ref])
        .json<any[]>();
      expect(keys.map((s) => s.key)).toEqual(["ONLY_KEY"]);
    });
  },
);

test(
  "a malformed file is refused without a partial import",
  {
    tag: "@import",
    annotation: about(
      "`import` of a broken file, or of stdin without --format, fails and leaves the environment as it was.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    const broken = await writeTemp(
      app,
      "secrets.json",
      `{"GOOD_KEY": "${app.value()}", "BROKEN": `,
    );
    const result = await step(
      `dopbase import ${env.ref} secrets.json (cut off)`,
      async () => app.cli(["import", env.ref, broken]).fails(1),
    );
    await step("It fails with a parse error", async () => {
      expect(result.stderr).toMatch(/^Error: /);
    });
    const badLine = await writeTemp(
      app,
      ".env",
      `GOOD_KEY=${app.value()}\nthis line has no equals sign\n`,
    );
    const dotenv = await step(
      `dopbase import ${env.ref} .env with a bad line`,
      async () => app.cli(["import", env.ref, badLine]).fails(1),
    );
    await step("It fails on the bad line", async () => {
      expect(dotenv.stderr).toMatch(/^Error: /);
    });
    const stdin = await step(
      `dopbase import ${env.ref} - without --format`,
      async () =>
        app.cli(["import", env.ref, "-"], { stdin: "A=b\n" }).fails(1),
    );
    await step("stdin needs --format", async () => {
      expect(stdin.stderr).toContain("--format");
    });
    await step("Only the original key is stored", async () => {
      const keys = await app
        .cli(["--json", "secret", "list", env.ref])
        .json<any[]>();
      expect(keys.map((s) => s.key)).toEqual(["API_KEY"]);
    });
  },
);

test(
  "export writes dotenv, JSON, YAML, TOML and a Docker env file",
  {
    tag: "@export",
    annotation: about(
      "With a read-level personal token, `export --stdout --format <f>` prints every format and `--output` writes an owner-only file that `--force` may replace.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const env = await app.make.environment();
    const apiKey = await app.make.secret(env, "API_KEY");
    const dbUrl = await app.make.secret(env, "DATABASE_URL");
    const reader = await readerToken(env);
    const exportAs = (format: string) =>
      app
        .cliRaw(["export", env.ref, "--stdout", "--format", format], {
          env: reader,
        })
        .stdout();

    const dotenv = await step(`dopbase export ${env.ref} --stdout`, async () =>
      app.cliRaw(["export", env.ref, "--stdout"], { env: reader }).stdout(),
    );
    await step("dotenv prints KEY=value lines, sorted", async () => {
      expect(dotenv.split("\n")).toEqual([
        `API_KEY=${apiKey}`,
        `DATABASE_URL=${dbUrl}`,
      ]);
    });
    const json = await step(
      `dopbase export ${env.ref} --stdout --format json`,
      async () => JSON.parse(await exportAs("json")),
    );
    await step("JSON is an object of keys to values", async () => {
      expect(json).toEqual({ API_KEY: apiKey, DATABASE_URL: dbUrl });
    });
    const yaml = await step(
      `dopbase export ${env.ref} --stdout --format yaml`,
      async () => exportAs("yaml"),
    );
    await step("YAML has KEY: value lines", async () => {
      expect(yaml).toContain(`API_KEY: ${apiKey}`);
      expect(yaml).toContain(`DATABASE_URL: ${dbUrl}`);
    });
    const toml = await step(
      `dopbase export ${env.ref} --stdout --format toml`,
      async () => exportAs("toml"),
    );
    await step("TOML has quoted KEY = value lines", async () => {
      expect(toml).toContain(`API_KEY = "${apiKey}"`);
      expect(toml).toContain(`DATABASE_URL = "${dbUrl}"`);
    });
    const docker = await step(
      `dopbase export ${env.ref} --stdout --format docker`,
      async () => exportAs("docker"),
    );
    await step("The Docker env file has bare KEY=value lines", async () => {
      expect(docker.split("\n")).toEqual([
        `API_KEY=${apiKey}`,
        `DATABASE_URL=${dbUrl}`,
      ]);
    });

    const dir = await tempDir(app, "export");
    const output = join(dir, "secrets.json");
    const written = await step(
      `dopbase --json export ${env.ref} --output secrets.json`,
      async () =>
        app
          .cliRaw(["--json", "export", env.ref, "--output", output], {
            env: reader,
          })
          .json(),
    );
    await step(
      "The file is JSON by its name and readable by the owner only",
      async () => {
        expect(written.secret_count).toBe(2);
        expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
          API_KEY: apiKey,
          DATABASE_URL: dbUrl,
        });
        expect((await stat(output)).mode & 0o077).toBe(0);
      },
    );
    const exists = await step(
      `dopbase export ${env.ref} --output secrets.json again`,
      async () =>
        app
          .cliRaw(["export", env.ref, "--output", output], { env: reader })
          .fails(1),
    );
    await step("It refuses to overwrite without --force", async () => {
      expect(exists.stderr).toMatch(/exists|--force/);
    });
    const forced = await step(
      `dopbase export ${env.ref} --output secrets.json --force`,
      async () =>
        app
          .cliRaw(["export", env.ref, "--output", output, "--force"], {
            env: reader,
          })
          .stdout(),
    );
    await step("It says Exported 2 secret(s)", async () => {
      expect(forced).toBe(`Exported 2 secret(s) to ${output}.`);
    });
    const neither = await step(
      `dopbase export ${env.ref} with no target`,
      async () => app.cliRaw(["export", env.ref], { env: reader }).fails(2),
    );
    await step(
      "It prints usage that asks for --output or --stdout",
      async () => {
        expect(neither.stdout + neither.stderr).toContain(
          "Requires --output <FILE> or --stdout.",
        );
      },
    );
  },
);

test(
  "export with a saved login asks for the password in a terminal",
  {
    tag: "@export",
    annotation: about(
      "Signed in with a session, `export` refuses without a terminal and works after typing the password.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const value = await app.make.secret(env, "API_KEY");
    const piped = await step(
      `dopbase export ${env.ref} --stdout with piped input`,
      async () => app.cli(["export", env.ref, "--stdout"]).fails(1),
    );
    await step("It needs an interactive password confirmation", async () => {
      expect(piped.stderr).toContain(
        "interactive password confirmation is required for plaintext secret access",
      );
    });
    const typed = await step(
      `dopbase export ${env.ref} --stdout, typing the root password`,
      async () =>
        pty(["export", env.ref, "--stdout"], {
          env: await signedInEnv(app),
          steps: [{ wait: "Password:", send: `${ROOT_PASSWORD}\r` }],
        }),
    );
    await step("It prints API_KEY=value", async () => {
      expect(typed.code).toBe(0);
      expect(typed.output).toContain(`API_KEY=${value}`);
    });
  },
);

test(
  "import then export gives back the same keys and values",
  {
    tag: ["@import", "@export"],
    annotation: about(
      "Secrets imported from a YAML file come back unchanged from `export --format yaml` and import cleanly into a second environment.",
    ),
  },
  async () => {
    const source = await app.make.environment();
    const values: Record<string, string> = {
      API_KEY: app.value(),
      DATABASE_URL: app.value(),
      REDIS_URL: app.value(),
    };
    const file = await writeTemp(
      app,
      "secrets.yaml",
      Object.entries(values)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n") + "\n",
    );
    await step(`dopbase import ${source.ref} secrets.yaml`, async () => {
      await app.cli(["import", source.ref, file]).ok();
    });
    const reader = await readerToken(source);
    const exported = await step(
      `dopbase export ${source.ref} --stdout --format json`,
      async () =>
        app
          .cliRaw(["export", source.ref, "--stdout", "--format", "json"], {
            env: reader,
          })
          .stdout(),
    );
    await step(
      "The export holds exactly the imported keys and values",
      async () => {
        expect(JSON.parse(exported)).toEqual(values);
      },
    );
    const target = await app.make.environment();
    await step(
      `dopbase import ${target.ref} - --format json from that export`,
      async () => {
        const result = await app
          .cli(["--json", "import", target.ref, "-", "--format", "json"], {
            stdin: exported,
          })
          .json();
        expect(result.addedKeys.sort()).toEqual(Object.keys(values).sort());
      },
    );
    await step("dopbase run in the copy sees the same values", async () => {
      for (const [key, value] of Object.entries(values)) {
        expect(await injected(app, target.ref, key)).toBe(value);
      }
    });
  },
);
