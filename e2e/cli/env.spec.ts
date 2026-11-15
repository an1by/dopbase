import {
  ROOT_PASSWORD,
  about,
  expect,
  step,
  test,
  useServer,
} from "../harness/index.ts";
import { pty } from "../harness/terminal.ts";
import { injected, script, signedInEnv } from "./support.ts";

const app = useServer();

test(
  "env create, list, show, rename and delete",
  {
    tag: "@environments",
    annotation: about(
      "An environment made with `env create` shows in `env list` and `env show`, keeps its id through `env rename`, and `env delete --yes` removes it with its secrets.",
    ),
  },
  async () => {
    const project = await app.make.project();
    const ref = `${project.name}/staging`;
    const created = await step(`dopbase --json env create ${ref}`, async () =>
      app.cli(["--json", "env", "create", ref]).json(),
    );
    await step("It returns the environment with an env_ id", async () => {
      expect(created.name).toBe("staging");
      expect(created.projectName).toBe(project.name);
      expect(created.id).toMatch(/^env_/);
      expect(created.protected).toBe(false);
    });
    const human = await step(
      `dopbase env create ${project.name}/qa`,
      async () => app.cli(["env", "create", `${project.name}/qa`]).stdout(),
    );
    await step("It says Created environment <project>/qa (<id>)", async () => {
      expect(human).toMatch(
        new RegExp(
          `^Created environment ${project.name}/qa \\(env_\\w+\\)\\.$`,
        ),
      );
    });

    const list = await step(
      `dopbase --json env list ${project.name}`,
      async () =>
        app.cli(["--json", "env", "list", project.name]).json<any[]>(),
    );
    await step("The project lists both environments", async () => {
      expect(list.map((e) => e.name).sort()).toEqual(["qa", "staging"]);
    });
    const table = await step(`dopbase env list ${project.name}`, async () =>
      app.cli(["env", "list", project.name]).stdout(),
    );
    await step("The table shows project/name and a count", async () => {
      expect(table).toMatch(/^ENVIRONMENT\s+ID\s+UPDATED/);
      expect(table).toContain(`${project.name}/staging`);
      expect(table).toMatch(/2 environment\(s\)$/);
    });
    const everything = await step("dopbase --json env list", async () =>
      app.cli(["--json", "env", "list"]).json<any[]>(),
    );
    await step(
      "Without a project it lists environments everywhere",
      async () => {
        expect(everything.map((e) => e.id)).toContain(created.id);
      },
    );

    await app.make.secret({ ...created, ref }, "API_KEY");
    const shown = await step(`dopbase env show ${ref}`, async () =>
      app.cli(["env", "show", ref]).stdout(),
    );
    await step("It shows project, name and id", async () => {
      expect(shown).toMatch(new RegExp(`Project:\\s+${project.name}`));
      expect(shown).toMatch(/Environment:\s+staging/);
      expect(shown).toMatch(new RegExp(`ID:\\s+${created.id}`));
    });
    const byId = await step(`dopbase --json env show ${created.id}`, async () =>
      app.cli(["--json", "env", "show", created.id]).json(),
    );
    await step("Showing by id counts its one secret", async () => {
      expect(byId.secretCount).toBe(1);
    });

    const renamed = await step(
      `dopbase --json env rename ${ref} prod`,
      async () => app.cli(["--json", "env", "rename", ref, "prod"]).json(),
    );
    await step("The id stays and the name changes", async () => {
      expect(renamed.id).toBe(created.id);
      expect(renamed.name).toBe("prod");
    });

    const unconfirmed = await step(
      `dopbase env delete ${project.name}/prod without --yes`,
      async () => app.cli(["env", "delete", `${project.name}/prod`]).fails(1),
    );
    await step("It asks for --yes and deletes nothing", async () => {
      expect(unconfirmed.stderr).toContain("Pass --yes");
      expect((await app.api.get(`/environments/${created.id}`)).status).toBe(
        200,
      );
    });
    const deleted = await step(
      `dopbase env delete ${project.name}/prod --yes`,
      async () =>
        app.cli(["env", "delete", `${project.name}/prod`, "--yes"]).stdout(),
    );
    await step("It says Deleted and counts the secret", async () => {
      expect(deleted).toContain(`Deleted environment ${project.name}/prod.`);
      expect(deleted).toMatch(/Secrets:\s+1/);
    });
    const missing = await step(
      `dopbase env show ${project.name}/prod`,
      async () => app.cli(["env", "show", `${project.name}/prod`]).fails(1),
    );
    await step("It is gone", async () => {
      expect(missing.stderr).toContain("ENVIRONMENT_NOT_FOUND");
    });
  },
);

test(
  "env create refuses a missing project and a duplicate name",
  {
    tag: "@environments",
    annotation: about(
      "`env create` into a project that doesn't exist, or with a name the project already has, exits 1.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const ghost = app.uniq("ghost");
    const noProject = await step(`dopbase env create ${ghost}/dev`, async () =>
      app.cli(["env", "create", `${ghost}/dev`]).fails(1),
    );
    await step("It says the project was not found", async () => {
      expect(noProject.stderr).toContain("PROJECT_NOT_FOUND");
    });
    const duplicate = await step(`dopbase env create ${env.ref}`, async () =>
      app.cli(["env", "create", env.ref]).fails(1),
    );
    await step(
      "A second environment with the same name is refused",
      async () => {
        expect(duplicate.stderr).toMatch(/^Error: \w+: /);
        const list = await app
          .cli(["--json", "env", "list", env.projectName])
          .json<any[]>();
        expect(list.filter((e) => e.name === env.name)).toHaveLength(1);
      },
    );
    const badRef = await step("dopbase env create no-slash", async () =>
      app.cli(["env", "create", "no-slash"]).fails(2),
    );
    await step("A reference without a slash is a usage error", async () => {
      expect(badRef.stderr).toContain("PROJECT_REF/ENVIRONMENT_NAME");
    });
  },
);

test(
  "env clone copies secrets into the new environment",
  {
    tag: "@environments",
    annotation: about(
      "`env clone <project>/<env> <name> --yes` creates the environment with the same keys and values, and refuses a name that exists.",
    ),
  },
  async () => {
    const source = await app.make.environment();
    const apiKey = await app.make.secret(source, "API_KEY");
    const dbUrl = await app.make.secret(source, "DATABASE_URL");
    const result = await step(
      `dopbase --json env clone ${source.ref} preview --yes`,
      async () =>
        app.cli(["--json", "env", "clone", source.ref, "preview", "--yes"]),
    );
    await step(
      "It lists the project's environments, now with preview",
      async () => {
        expect(result.code).toBe(0);
        const list = JSON.parse(result.stdout) as any[];
        const preview = list.find((e) => e.name === "preview");
        expect(preview.secretCount).toBe(2);
        expect(result.stderr).toMatch(/Secrets:\s+2/);
      },
    );
    const ref = `${source.projectName}/preview`;
    await step(`dopbase secret list ${ref} shows both keys`, async () => {
      const keys = await app
        .cli(["--json", "secret", "list", ref])
        .json<any[]>();
      expect(keys.map((s) => s.key).sort()).toEqual([
        "API_KEY",
        "DATABASE_URL",
      ]);
    });
    await step("dopbase run in the clone sees the same values", async () => {
      expect(await injected(app, ref, "API_KEY")).toBe(apiKey);
      expect(await injected(app, ref, "DATABASE_URL")).toBe(dbUrl);
    });
    const human = await step(
      `dopbase env clone ${source.ref} preview2 --yes`,
      async () =>
        app.cli(["env", "clone", source.ref, "preview2", "--yes"]).stdout(),
    );
    await step("It says Cloned 2 secrets", async () => {
      expect(human).toContain(
        `Cloned 2 secrets from ${source.ref} to ${source.projectName}/preview2.`,
      );
    });
    const again = await step(
      `dopbase env clone ${source.ref} preview --yes again`,
      async () =>
        app.cli(["env", "clone", source.ref, "preview", "--yes"]).fails(1),
    );
    await step("It says the environment already exists", async () => {
      expect(again.stderr).toContain(`Environment ${ref} already exists.`);
    });
  },
);

test(
  "env default saves and clears the default environment",
  {
    tag: "@environments",
    annotation: about(
      "`env default <ref>` saves it for this server, `run` then needs no reference, and `env default --clear` removes it.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const value = await app.make.secret(env, "API_KEY");
    const saved = await step(
      `dopbase --json env default ${env.ref}`,
      async () => app.cli(["--json", "env", "default", env.ref]).json(),
    );
    try {
      await step("It saves the environment as the default", async () => {
        expect(saved.default).toBe(true);
        expect(saved.environment.id).toBe(env.id);
      });
      await step(
        "dopbase run -- sh -c … uses the default environment",
        async () => {
          const result = await app
            .cli(["run", "--", "sh", "-c", 'printf %s "$API_KEY"'])
            .ok();
          expect(result.stdout).toBe(value);
        },
      );
    } finally {
      const cleared = await step("dopbase env default --clear", async () =>
        app.cli(["env", "default", "--clear"]).stdout(),
      );
      await step("It says Cleared the default environment", async () => {
        expect(cleared).toBe("Cleared the default environment.");
      });
    }
    const again = await step("dopbase env default --clear again", async () =>
      app.cli(["env", "default", "--clear"]).stdout(),
    );
    await step("It says no default was set", async () => {
      expect(again).toBe("No default environment was set.");
    });
    const run = await step("dopbase run -- true with no default", async () =>
      app.cli(["run", "--", "true"]).fails(1),
    );
    await step("run asks for a default environment", async () => {
      expect(run.stderr).toContain("No default environment is set.");
    });
  },
);

test(
  "env edit changes secrets through an editor",
  {
    tag: "@environments",
    annotation: about(
      "`env edit` needs a terminal; with an editor that adds a line, --dry-run previews the new key without saving, and a confirmed edit saves it. The catalog asked for the protected flag, but `env edit` edits the .env document only.",
    ),
  },
  async () => {
    test.setTimeout(60_000);
    const env = await app.make.environment();
    const kept = await app.make.secret(env, "API_KEY");
    const added = app.value();
    const editor = await script(
      app,
      "add-line.sh",
      `printf 'NEW_KEY=%s\\n' '${added}' >> "$1"`,
    );
    const piped = await step(
      `dopbase env edit ${env.ref} with piped input`,
      async () =>
        app.cli(["env", "edit", env.ref, "--editor", editor]).fails(1),
    );
    await step("It refuses without an interactive terminal", async () => {
      expect(piped.stderr).toContain(
        "env edit requires an interactive terminal",
      );
    });

    const clientEnv = await signedInEnv(app);
    const openEditor = [
      { wait: "Open secrets with this custom editor command?", send: "y\r" },
      { wait: "Password:", send: `${ROOT_PASSWORD}\r` },
    ];
    const dryRun = await step(
      `dopbase env edit ${env.ref} --editor add-line.sh --dry-run`,
      async () =>
        pty(["env", "edit", env.ref, "--editor", editor, "--dry-run"], {
          env: clientEnv,
          steps: openEditor,
        }),
    );
    await step("The preview adds NEW_KEY and saves nothing", async () => {
      expect(dryRun.code).toBe(0);
      expect(dryRun.output).toMatch(/Added:\s+1 \(NEW_KEY\)/);
      expect(dryRun.output).toContain(
        "Dry run complete. No changes were saved.",
      );
      const keys = await app
        .cli(["--json", "secret", "list", env.ref])
        .json<any[]>();
      expect(keys.map((s) => s.key)).toEqual(["API_KEY"]);
    });

    const applied = await step(
      `dopbase env edit ${env.ref} --editor add-line.sh, then a to apply`,
      async () =>
        pty(["env", "edit", env.ref, "--editor", editor], {
          env: clientEnv,
          steps: [
            ...openEditor,
            { wait: "(a)Apply, (e)edit again, or (c)cancel?", send: "a\r" },
          ],
        }),
    );
    await step("It says Saved secrets", async () => {
      expect(applied.code).toBe(0);
      expect(applied.output).toContain(`Saved secrets in ${env.ref}.`);
    });
    await step("run sees the new key and the old one unchanged", async () => {
      expect(await injected(app, env.ref, "NEW_KEY")).toBe(added);
      expect(await injected(app, env.ref, "API_KEY")).toBe(kept);
    });
  },
);
