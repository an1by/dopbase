import {
  ROOT_PASSWORD,
  about,
  expect,
  step,
  test,
  useServer,
} from "../harness/index.ts";
import { pty } from "../harness/terminal.ts";
import { injected, signedInEnv } from "./support.ts";

const app = useServer();

test(
  "secret set reads the value from stdin",
  {
    tag: "@secrets",
    annotation: about(
      "`secret set --stdin` saves the piped value exactly, a second set makes version 2, and without --stdin a non-interactive set is refused.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const first = app.value();
    const saved = await step(
      `printf … | dopbase --json secret set ${env.ref} API_KEY --stdin`,
      async () =>
        app
          .cli(["--json", "secret", "set", env.ref, "API_KEY", "--stdin"], {
            stdin: first,
          })
          .json(),
    );
    await step("It saves version 1", async () => {
      expect(saved.key).toBe("API_KEY");
      expect(saved.version).toBe(1);
    });
    await step("dopbase run sees the exact value", async () => {
      expect(await injected(app, env.ref, "API_KEY")).toBe(first);
    });
    const second = app.value();
    const human = await step(
      `printf … | dopbase secret set ${env.ref} API_KEY --stdin`,
      async () =>
        app
          .cli(["secret", "set", env.ref, "API_KEY", "--stdin"], {
            stdin: second,
          })
          .stdout(),
    );
    await step("It says Saved API_KEY and Version: 2", async () => {
      expect(human).toContain(`Saved API_KEY in ${env.ref}.`);
      expect(human).toMatch(/Version:\s+2/);
      expect(human).not.toContain(second);
    });
    const refused = await step(
      `dopbase secret set ${env.ref} OTHER without --stdin`,
      async () =>
        app
          .cli(["secret", "set", env.ref, "OTHER"], { stdin: app.value() })
          .fails(1),
    );
    await step("It asks for --stdin and saves nothing", async () => {
      expect(refused.stderr).toContain(
        "use --stdin when setting a secret non-interactively",
      );
      const keys = await app
        .cli(["--json", "secret", "list", env.ref])
        .json<any[]>();
      expect(keys.map((s) => s.key)).toEqual(["API_KEY"]);
    });
    const missing = await step(
      `dopbase secret set ${env.projectName}/nope API_KEY --stdin`,
      async () =>
        app
          .cli(
            ["secret", "set", `${env.projectName}/nope`, "API_KEY", "--stdin"],
            {
              stdin: app.value(),
            },
          )
          .fails(1),
    );
    await step("An unknown environment is refused", async () => {
      expect(missing.stderr).toContain("ENVIRONMENT_NOT_FOUND");
    });
  },
);

test(
  "secret list shows keys and never values",
  {
    tag: "@secrets",
    annotation: about(
      "`secret list` prints keys, versions and times in a table and as JSON, and no stored value appears in either.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    await app.make.secret(env, "DATABASE_URL");
    const json = await step(`dopbase --json secret list ${env.ref}`, async () =>
      app.cli(["--json", "secret", "list", env.ref]).json<any[]>(),
    );
    await step(
      "JSON lists both keys with versions and no value field",
      async () => {
        expect(json.map((s) => s.key).sort()).toEqual([
          "API_KEY",
          "DATABASE_URL",
        ]);
        for (const secret of json) {
          expect(secret.version).toBe(1);
          expect(secret).not.toHaveProperty("value");
        }
      },
    );
    const table = await step(`dopbase secret list ${env.ref}`, async () =>
      app.cli(["secret", "list", env.ref]).stdout(),
    );
    await step(
      "The table has KEY, VERSION, UPDATED and 2 secret(s)",
      async () => {
        expect(table).toMatch(/^KEY\s+VERSION\s+UPDATED/);
        expect(table).toContain("DATABASE_URL");
        expect(table).toMatch(/2 secret\(s\)$/);
      },
    );
    const empty = await app.make.environment();
    const none = await step(`dopbase secret list ${empty.ref}`, async () =>
      app.cli(["secret", "list", empty.ref]).stdout(),
    );
    await step("An empty environment says so", async () => {
      expect(none).toBe(`No secrets found in ${empty.ref}.`);
    });
  },
);

test(
  "secret get shows metadata, and --reveal prints the value after a password",
  {
    tag: "@secrets",
    annotation: about(
      "`secret get` shows key, version and times; `--reveal` needs the password in a terminal and prints the value, also for an earlier `--version`.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const v1 = await app.make.secret(env, "API_KEY");
    const v2 = await app.make.secret(env, "API_KEY");
    const meta = await step(
      `dopbase --json secret get ${env.ref} API_KEY`,
      async () =>
        app.cli(["--json", "secret", "get", env.ref, "API_KEY"]).json(),
    );
    await step("It shows version 2 and no value", async () => {
      expect(meta.key).toBe("API_KEY");
      expect(meta.version).toBe(2);
      expect(meta).not.toHaveProperty("value");
    });
    const human = await step(
      `dopbase secret get ${env.ref} API_KEY`,
      async () => app.cli(["secret", "get", env.ref, "API_KEY"]).stdout(),
    );
    await step("It reads Key: API_KEY and Version: 2", async () => {
      expect(human).toMatch(/Key:\s+API_KEY/);
      expect(human).toMatch(/Version:\s+2/);
      expect(human).not.toContain(v2);
    });
    const old = await step(
      `dopbase --json secret get ${env.ref} API_KEY --version 1`,
      async () =>
        app
          .cli([
            "--json",
            "secret",
            "get",
            env.ref,
            "API_KEY",
            "--version",
            "1",
          ])
          .json(),
    );
    await step("--version 1 shows the first version's metadata", async () => {
      expect(old.version).toBe(1);
      expect(old.changeType).toBe("created");
      expect(old.current).toBe(false);
    });

    const piped = await step(
      `dopbase secret get ${env.ref} API_KEY --reveal with piped input`,
      async () =>
        app.cli(["secret", "get", env.ref, "API_KEY", "--reveal"]).fails(1),
    );
    await step("It needs an interactive password confirmation", async () => {
      expect(piped.stderr).toContain(
        "interactive password confirmation is required for plaintext secret access",
      );
    });
    const clientEnv = await signedInEnv(app);
    const revealed = await step(
      `dopbase secret get ${env.ref} API_KEY --reveal, typing the password`,
      async () =>
        pty(["secret", "get", env.ref, "API_KEY", "--reveal"], {
          env: clientEnv,
          steps: [{ wait: "Password:", send: `${ROOT_PASSWORD}\r` }],
        }),
    );
    await step("It prints the current value", async () => {
      expect(revealed.code).toBe(0);
      expect(revealed.output).toContain(v2);
      expect(revealed.output).not.toContain(v1);
    });
    const revealedOld = await step(
      `dopbase secret get ${env.ref} API_KEY --version 1 --reveal`,
      async () =>
        pty(
          ["secret", "get", env.ref, "API_KEY", "--version", "1", "--reveal"],
          {
            env: clientEnv,
            steps: [{ wait: "Password:", send: `${ROOT_PASSWORD}\r` }],
          },
        ),
    );
    await step("It prints the first value", async () => {
      expect(revealedOld.code).toBe(0);
      expect(revealedOld.output).toContain(v1);
    });
    const wrong = await step(
      `dopbase secret get ${env.ref} API_KEY --reveal with a wrong password`,
      async () =>
        pty(["secret", "get", env.ref, "API_KEY", "--reveal"], {
          env: clientEnv,
          steps: [{ wait: "Password:", send: "not-the-password\r" }],
        }),
    );
    await step("It fails and prints no value", async () => {
      expect(wrong.code).toBe(1);
      expect(wrong.output).not.toContain(v2);
    });
  },
);

test(
  "secret history lists versions newest first without values",
  {
    tag: "@secrets",
    annotation: about(
      "After three saves `secret history` lists v3, v2, v1 with the current one marked, never shows a value, and pages with --limit and --before.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const values = [
      await app.make.secret(env, "API_KEY"),
      await app.make.secret(env, "API_KEY"),
      await app.make.secret(env, "API_KEY"),
    ];
    const page = await step(
      `dopbase --json secret history ${env.ref} API_KEY`,
      async () =>
        app.cli(["--json", "secret", "history", env.ref, "API_KEY"]).json(),
    );
    await step("History lists 3 versions, newest first", async () => {
      expect(page.items.map((i: any) => i.version)).toEqual([3, 2, 1]);
      expect(page.items[0].current).toBe(true);
      expect(page.items[2].changeType).toBe("created");
      expect(page.nextBefore).toBeNull();
      for (const item of page.items) expect(item).not.toHaveProperty("value");
    });
    const table = await step(
      `dopbase secret history ${env.ref} API_KEY`,
      async () => app.cli(["secret", "history", env.ref, "API_KEY"]).stdout(),
    );
    await step(
      "The table marks v3 current and the rest available",
      async () => {
        expect(table).toMatch(/^VERSION\s+CHANGE\s+BY\s+SAVED\s+STATUS/);
        expect(table).toMatch(/v3\s+updated\s+root@dopbase\.com.*current/);
        expect(table).toMatch(/v1\s+created.*available/);
        expect(table).toMatch(/3 version\(s\)$/);
        for (const value of values) expect(table).not.toContain(value);
      },
    );
    const first = await step(
      `dopbase secret history ${env.ref} API_KEY --limit 2`,
      async () =>
        app.cli(["secret", "history", env.ref, "API_KEY", "--limit", "2"]).ok(),
    );
    await step("It prints two versions and the next-page command", async () => {
      expect(first.stdout).toMatch(/2 version\(s\)/);
      expect(first.stderr).toContain(
        `More versions exist. Next page: dopbase secret history ${env.ref} API_KEY --limit 2 --before 2`,
      );
    });
    const next = await step(
      `dopbase --json secret history ${env.ref} API_KEY --limit 2 --before 2`,
      async () =>
        app
          .cli([
            "--json",
            "secret",
            "history",
            env.ref,
            "API_KEY",
            "--limit",
            "2",
            "--before",
            "2",
          ])
          .json(),
    );
    await step("The next page holds v1 only", async () => {
      expect(next.items.map((i: any) => i.version)).toEqual([1]);
    });
  },
);

test(
  "secret rollback saves the old value as a new version",
  {
    tag: "@secrets",
    annotation: about(
      "Rolling API_KEY back to v1 makes v3 with v1's value, history keeps every version, and rollback refuses the current version or a missing VERSION.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const v1 = await app.make.secret(env, "API_KEY");
    await app.make.secret(env, "API_KEY");
    const noVersion = await step(
      `dopbase secret rollback ${env.ref} API_KEY --yes`,
      async () =>
        app.cli(["secret", "rollback", env.ref, "API_KEY", "--yes"]).fails(1),
    );
    await step("--yes needs a VERSION", async () => {
      expect(noVersion.stderr).toContain("--yes needs a VERSION");
    });
    const piped = await step(
      `dopbase secret rollback ${env.ref} API_KEY with piped input`,
      async () => app.cli(["secret", "rollback", env.ref, "API_KEY"]).fails(1),
    );
    await step("Without a terminal it asks for VERSION", async () => {
      expect(piped.stderr).toContain(
        "pass VERSION when running non-interactively",
      );
    });
    const current = await step(
      `dopbase secret rollback ${env.ref} API_KEY 2 --yes`,
      async () =>
        app
          .cli(["secret", "rollback", env.ref, "API_KEY", "2", "--yes"])
          .fails(1),
    );
    await step("Rolling back to the current version is refused", async () => {
      expect(current.stderr).toContain(
        "v2 is already the current value of API_KEY",
      );
    });

    const rolled = await step(
      `dopbase secret rollback ${env.ref} API_KEY 1 --yes`,
      async () =>
        app
          .cli(["secret", "rollback", env.ref, "API_KEY", "1", "--yes"])
          .stdout(),
    );
    await step("It says Rolled back to the value from v1, now v3", async () => {
      expect(rolled).toContain(
        "Rolled back API_KEY to the value from v1. Current version: v3.",
      );
      expect(rolled).toMatch(/Result:\s+saved as v3 with the value from v1/);
    });
    await step("dopbase run sees v1's value again", async () => {
      expect(await injected(app, env.ref, "API_KEY")).toBe(v1);
    });
    await step("History lists 3 versions; v3 rolled back from v1", async () => {
      const page = await app
        .cli(["--json", "secret", "history", env.ref, "API_KEY"])
        .json();
      expect(page.items.map((i: any) => i.version)).toEqual([3, 2, 1]);
      expect(page.items[0].changeType).toBe("rolled_back");
      expect(page.items[0].sourceVersion).toBe(1);
    });
    const missing = await step(
      `dopbase secret rollback ${env.ref} API_KEY 9 --yes`,
      async () =>
        app
          .cli(["secret", "rollback", env.ref, "API_KEY", "9", "--yes"])
          .fails(1),
    );
    await step("A version that doesn't exist is refused", async () => {
      expect(missing.stderr).toContain(
        `version 9 of API_KEY was not found in ${env.ref}`,
      );
    });
  },
);

test(
  "secret delete removes the key, and getting it afterwards fails",
  {
    tag: "@secrets",
    annotation: about(
      "`secret delete --yes` removes the key; without --yes it needs a terminal; `secret get` of the deleted key exits 1.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    await app.make.secret(env, "KEEP_ME");
    const unconfirmed = await step(
      `dopbase secret delete ${env.ref} API_KEY without --yes`,
      async () => app.cli(["secret", "delete", env.ref, "API_KEY"]).fails(1),
    );
    await step("It asks for --yes", async () => {
      expect(unconfirmed.stderr).toContain("Pass --yes");
    });
    const deleted = await step(
      `dopbase secret delete ${env.ref} API_KEY --yes`,
      async () =>
        app.cli(["secret", "delete", env.ref, "API_KEY", "--yes"]).stdout(),
    );
    await step("It says Deleted API_KEY", async () => {
      expect(deleted).toBe(`Deleted API_KEY from ${env.ref}.`);
    });
    await step("Only KEEP_ME is left", async () => {
      const keys = await app
        .cli(["--json", "secret", "list", env.ref])
        .json<any[]>();
      expect(keys.map((s) => s.key)).toEqual(["KEEP_ME"]);
    });
    const gone = await step(`dopbase secret get ${env.ref} API_KEY`, async () =>
      app.cli(["secret", "get", env.ref, "API_KEY"]).fails(1),
    );
    await step("Getting it exits 1 with SECRET_NOT_FOUND", async () => {
      expect(gone.stderr).toContain("SECRET_NOT_FOUND");
    });
    const again = await step(
      `dopbase secret delete ${env.ref} API_KEY --yes again`,
      async () =>
        app.cli(["secret", "delete", env.ref, "API_KEY", "--yes"]).fails(1),
    );
    await step("Deleting it again fails the same way", async () => {
      expect(again.stderr).toContain("SECRET_NOT_FOUND");
    });
  },
);
