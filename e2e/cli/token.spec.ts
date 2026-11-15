import { grant, printVar, tempDir, tokenEnv } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";

// Members and personal tokens need people management turned on.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "runner token create, list and revoke",
  {
    tag: "@tokens",
    annotation: about(
      "`token create` prints a dbs_ token once, `token list` shows it active and never shows the token, and `token revoke` marks it revoked.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const created = await step(
      `dopbase --json token create ${env.ref} --name deploy --expires-in 45d`,
      async () =>
        app
          .cli([
            "--json",
            "token",
            "create",
            env.ref,
            "--name",
            "deploy",
            "--expires-in",
            "45d",
          ])
          .json(),
    );
    await step(
      "It returns a tok_ id and a dbs_ token for the environment",
      async () => {
        expect(created.token.id).toMatch(/^tok_/);
        expect(created.token.environmentId).toBe(env.id);
        expect(created.plaintextToken).toMatch(/^dbs_/);
        const days =
          (Date.parse(created.token.expiresAt) -
            Date.parse(created.token.createdAt)) /
          86_400_000;
        expect(Math.round(days)).toBe(45);
      },
    );
    const human = await step(
      `dopbase token create ${env.ref} --name ci`,
      async () =>
        app.cli(["token", "create", env.ref, "--name", "ci"]).stdout(),
    );
    await step(
      "It says Created token ci and shows the token once",
      async () => {
        expect(human).toContain(`Created token ci for ${env.ref}.`);
        expect(human).toMatch(/Token:\s+dbs_\S+/);
      },
    );

    const list = await step(`dopbase --json token list ${env.ref}`, async () =>
      app.cli(["--json", "token", "list", env.ref]).json<any[]>(),
    );
    await step("Both tokens are listed, without the secret part", async () => {
      expect(list.map((t) => t.name).sort()).toEqual(["ci", "deploy"]);
      expect(JSON.stringify(list)).not.toContain(created.plaintextToken);
    });
    const revoked = await step(
      `dopbase token revoke ${created.token.id}`,
      async () => app.cli(["token", "revoke", created.token.id]).stdout(),
    );
    await step("It says Revoked token", async () => {
      expect(revoked).toBe(`Revoked token ${created.token.id}.`);
    });
    const table = await step(`dopbase token list ${env.ref}`, async () =>
      app.cli(["token", "list", env.ref]).stdout(),
    );
    await step("The table shows deploy revoked and ci active", async () => {
      expect(table).toMatch(
        /^NAME\s+ID\s+STATUS\s+EXPIRES\s+LAST USED\s+CREATED/,
      );
      expect(table).toMatch(
        new RegExp(`deploy\\s+${created.token.id}\\s+revoked`),
      );
      expect(table).toMatch(/ci\s+tok_\w+\s+active/);
    });
    const bad = await step(
      `dopbase token create ${env.ref} --name long --expires-in 400d`,
      async () =>
        app
          .cli([
            "token",
            "create",
            env.ref,
            "--name",
            "long",
            "--expires-in",
            "400d",
          ])
          .fails(),
    );
    await step("A lifetime over 365 days is refused", async () => {
      expect(bad.stderr).toMatch(/365|expires/i);
    });
    const never = await step(
      `dopbase token create ${env.ref} --name forever --expires-in never`,
      async () =>
        app
          .cli([
            "token",
            "create",
            env.ref,
            "--name",
            "forever",
            "--expires-in",
            "never",
          ])
          .fails(),
    );
    await step("A token that never expires is refused", async () => {
      expect(never.stderr).toContain("Runner tokens always expire.");
    });
  },
);

test(
  "a revoked runner token is refused by run",
  {
    tag: ["@tokens", "@run"],
    annotation: about(
      "A runner token works with `dopbase run` until `token revoke`; after that run fails with an authentication error and never starts the child.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const value = await app.make.secret(env, "API_KEY");
    const created = await app
      .cli(["--json", "token", "create", env.ref, "--name", "ci"])
      .json();
    const ci = tokenEnv(
      app,
      created.plaintextToken,
      await tempDir(app, "token"),
    );
    await step("DOPBASE_TOKEN=dbs_… dopbase run -- … works", async () => {
      const result = await app
        .cliRaw(["run", "--", ...printVar("API_KEY")], { env: ci })
        .stdout();
      expect(result).toBe(value);
    });
    await step(`dopbase token revoke ${created.token.id}`, async () => {
      await app.cli(["token", "revoke", created.token.id]).ok();
    });
    const refused = await step(
      "DOPBASE_TOKEN=dbs_… dopbase run -- … after revoke",
      async () =>
        app
          .cliRaw(["run", "--", "sh", "-c", "echo started"], {
            env: { ...ci, DOPBASE_DATA_DIR: await tempDir(app, "revoked") },
          })
          .fails(1),
    );
    await step(
      "It fails authentication and the child never starts",
      async () => {
        expect(refused.stderr).toContain("Dopbase authentication failed");
        expect(refused.stdout).not.toContain("started");
      },
    );
  },
);

test(
  "personal token create, list and revoke",
  {
    tag: "@tokens",
    annotation: about(
      "A member's `token personal create` prints a dpp_ token with its level and scope, `token personal list` shows it, and `token personal revoke` ends it; root has no personal tokens.",
    ),
  },
  async () => {
    const member = await app.make.user({ role: "Member" });
    const project = await app.make.project();
    await grant(app, member, "write", { project: project.name });
    const created = await step(
      `dopbase --json token personal create --name laptop --level metadata --project ${project.name}`,
      async () =>
        app
          .cli(
            [
              "--json",
              "token",
              "personal",
              "create",
              "--name",
              "laptop",
              "--level",
              "metadata",
              "--project",
              project.name,
            ],
            { as: member },
          )
          .json(),
    );
    await step(
      "It returns a dpp_ token with level metadata on the project",
      async () => {
        expect(created.plaintextToken).toMatch(/^dpp_/);
        expect(created.token.level).toBe("metadata");
        expect(created.token.scopeLabel).toBe(project.name);
      },
    );
    const human = await step(
      "dopbase token personal create --name reader",
      async () =>
        app
          .cli(["token", "personal", "create", "--name", "reader"], {
            as: member,
          })
          .stdout(),
    );
    await step(
      "It says Created personal token reader, up to read on all projects",
      async () => {
        expect(human).toContain("Created personal token reader.");
        expect(human).toMatch(/Up to:\s+read on all projects/);
        expect(human).toMatch(/Token:\s+dpp_\S+/);
      },
    );
    const list = await step("dopbase --json token personal list", async () =>
      app
        .cli(["--json", "token", "personal", "list"], { as: member })
        .json<any[]>(),
    );
    await step("Both tokens are listed", async () => {
      expect(list.map((t) => t.name).sort()).toEqual(["laptop", "reader"]);
    });
    const revoked = await step(
      `dopbase token personal revoke ${created.token.id}`,
      async () =>
        app
          .cli(["token", "personal", "revoke", created.token.id], {
            as: member,
          })
          .stdout(),
    );
    await step("It says Revoked personal token", async () => {
      expect(revoked).toBe(`Revoked personal token ${created.token.id}.`);
    });
    const table = await step("dopbase token personal list", async () =>
      app.cli(["token", "personal", "list"], { as: member }).stdout(),
    );
    await step("laptop shows revoked", async () => {
      expect(table).toMatch(
        /^NAME\s+ID\s+STATUS\s+LEVEL\s+SCOPE\s+EXPIRES\s+LAST USED/,
      );
      expect(table).toMatch(/laptop\s+ptk_\w+\s+revoked/);
    });
    await step("The revoked token no longer works", async () => {
      const refused = await app
        .cliRaw(["project", "list"], {
          env: tokenEnv(
            app,
            created.plaintextToken,
            await tempDir(app, "token"),
          ),
        })
        .fails(1);
      expect(refused.stderr).toMatch(/^Error: AUTHENTICATION_INVALID: /);
    });
    const root = await step(
      "dopbase token personal create --name x as root",
      async () =>
        app.cli(["token", "personal", "create", "--name", "x"]).fails(1),
    );
    await step("Root is refused: it has no personal tokens", async () => {
      expect(root.stderr).toContain("ROOT_PROTECTED");
    });
  },
);

test(
  "a personal token never reaches more than its scope and level",
  {
    tag: "@tokens",
    annotation: about(
      "A metadata token scoped to one project lists that project's keys but can't read values, write, or see another project the member can reach.",
    ),
  },
  async () => {
    const member = await app.make.user({ role: "Member" });
    const inScope = await app.make.environment();
    const outOfScope = await app.make.environment();
    await app.make.secret(inScope, "API_KEY");
    await app.make.secret(outOfScope, "API_KEY");
    await grant(app, member, "write", { project: inScope.projectName });
    await grant(app, member, "write", { project: outOfScope.projectName });
    const created = await app
      .cli(
        [
          "--json",
          "token",
          "personal",
          "create",
          "--name",
          app.uniq("scoped"),
          "--level",
          "metadata",
          "--project",
          inScope.projectName,
        ],
        { as: member },
      )
      .json();
    const env = tokenEnv(
      app,
      created.plaintextToken,
      await tempDir(app, "token"),
    );

    await step(
      `DOPBASE_TOKEN=dpp_… dopbase secret list ${inScope.ref}`,
      async () => {
        const keys = await app
          .cliRaw(["--json", "secret", "list", inScope.ref], { env })
          .json<any[]>();
        expect(keys.map((s) => s.key)).toEqual(["API_KEY"]);
      },
    );
    const projects = await step(
      "DOPBASE_TOKEN=dpp_… dopbase project list",
      async () =>
        app.cliRaw(["--json", "project", "list"], { env }).json<any[]>(),
    );
    await step("Only the scoped project is visible", async () => {
      expect(projects.map((p) => p.name)).toEqual([inScope.projectName]);
    });
    const outside = await step(
      `DOPBASE_TOKEN=dpp_… dopbase secret list ${outOfScope.ref}`,
      async () =>
        app.cliRaw(["secret", "list", outOfScope.ref], { env }).fails(1),
    );
    await step("The other project is out of reach", async () => {
      // Not found rather than denied, so the token can't tell it exists.
      expect(outside.stderr).toMatch(/^Error: ENVIRONMENT_NOT_FOUND: /);
    });
    const values = await step(
      `DOPBASE_TOKEN=dpp_… dopbase export ${inScope.ref} --stdout`,
      async () =>
        app.cliRaw(["export", inScope.ref, "--stdout"], { env }).fails(1),
    );
    await step("Metadata level can't read values", async () => {
      expect(values.stderr).toMatch(/^Error: AUTHORIZATION_DENIED: /);
      expect(values.stdout).toBe("");
    });
    const write = await step(
      `DOPBASE_TOKEN=dpp_… dopbase secret set ${inScope.ref} NEW --stdin`,
      async () =>
        app
          .cliRaw(["secret", "set", inScope.ref, "NEW", "--stdin"], {
            env,
            stdin: app.value(),
          })
          .fails(1),
    );
    await step("Metadata level can't write either", async () => {
      expect(write.stderr).toMatch(/^Error: AUTHORIZATION_DENIED: /);
      const keys = await app
        .cli(["--json", "secret", "list", inScope.ref])
        .json<any[]>();
      expect(keys.map((s) => s.key)).toEqual(["API_KEY"]);
    });
  },
);

test(
  "token create --role takes only the runner role",
  {
    tag: "@tokens",
    annotation: about(
      "`token create --role runner` is the default spelled out and makes a working dbs_ token; any other role is refused with TOKEN_SCOPE_INVALID.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const created = await step(
      `dopbase --json token create ${env.ref} --name deploy --role runner`,
      async () =>
        app
          .cli([
            "--json",
            "token",
            "create",
            env.ref,
            "--name",
            "deploy",
            "--role",
            "runner",
          ])
          .json(),
    );
    await step("It returns a dbs_ token for the environment", async () => {
      expect(created.plaintextToken).toMatch(/^dbs_/);
      expect(created.token.environmentId).toBe(env.id);
    });
    const refused = await step(
      `dopbase token create ${env.ref} --name admin --role admin`,
      async () =>
        app
          .cli([
            "token",
            "create",
            env.ref,
            "--name",
            "admin",
            "--role",
            "admin",
          ])
          .fails(1),
    );
    await step("Another role is refused and no token is made", async () => {
      expect(refused.stderr).toContain("TOKEN_SCOPE_INVALID");
      expect(refused.stderr).toContain("Only the runner role is supported");
      const list = await app
        .cli(["--json", "token", "list", env.ref], { record: false })
        .json<any[]>();
      expect(list.map((t) => t.name)).toEqual(["deploy"]);
    });
  },
);

test(
  "an Auditor's --audit token reads the audit log and no project data",
  {
    tag: ["@tokens", "@audit"],
    annotation: about(
      "An Auditor's `token personal create --audit` makes a token scoped to the audit log: it lists audit events but reaches no project. Auditors can't make data tokens, and Members can't make audit tokens.",
    ),
  },
  async () => {
    const auditor = await app.make.user({ role: "Auditor" });
    const member = await app.make.user({ role: "Member" });
    const target = await app.make.environment();
    await app.make.secret(target, "API_KEY");

    const created = await step(
      "dopbase --json token personal create --name siem --audit, as an Auditor",
      async () =>
        app
          .cli(
            [
              "--json",
              "token",
              "personal",
              "create",
              "--name",
              "siem",
              "--audit",
            ],
            { as: auditor },
          )
          .json(),
    );
    await step("It returns a dpp_ token scoped to the audit log", async () => {
      expect(created.plaintextToken).toMatch(/^dpp_/);
      expect(created.token.scopeType).toBe("audit");
    });
    const human = await step(
      "dopbase token personal create --name siem-2 --audit, as an Auditor",
      async () =>
        app
          .cli(["token", "personal", "create", "--name", "siem-2", "--audit"], {
            as: auditor,
          })
          .stdout(),
    );
    await step("It says the token reaches the audit log", async () => {
      expect(human).toContain("Created personal token siem-2.");
      expect(human).toMatch(/Up to:\s+\S+ on the audit log/);
    });

    const env = tokenEnv(
      app,
      created.plaintextToken,
      await tempDir(app, "audit"),
    );
    const page = await step(
      "DOPBASE_TOKEN=dpp_… dopbase --json audit list",
      async () => app.cliRaw(["--json", "audit", "list"], { env }).json(),
    );
    await step("The audit token reads audit events", async () => {
      expect(page.items.length).toBeGreaterThan(0);
    });
    // With a metadata grant the Auditor's own session sees the project, so an
    // empty list through the token comes from the token's audit scope.
    await grant(app, auditor, "metadata", { project: target.projectName });
    const own = await step(
      "dopbase --json project list, as the Auditor with a metadata grant",
      async () =>
        app.cli(["--json", "project", "list"], { as: auditor }).json<any[]>(),
    );
    await step("The Auditor's session sees the project", async () => {
      expect(own.map((p) => p.name)).toContain(target.projectName);
    });
    const projects = await step(
      "DOPBASE_TOKEN=dpp_… dopbase --json project list",
      async () =>
        app.cliRaw(["--json", "project", "list"], { env }).json<any[]>(),
    );
    await step("The audit token still sees no projects", async () => {
      expect(projects).toEqual([]);
    });

    const dataToken = await step(
      "dopbase token personal create --name data, as an Auditor",
      async () =>
        app
          .cli(["token", "personal", "create", "--name", "data"], {
            as: auditor,
          })
          .fails(1),
    );
    await step("An Auditor's tokens must use the audit scope", async () => {
      expect(dataToken.stderr).toContain(
        "This account's tokens read the audit log only.",
      );
    });
    const memberAudit = await step(
      "dopbase token personal create --name siem --audit, as a Member",
      async () =>
        app
          .cli(["token", "personal", "create", "--name", "siem", "--audit"], {
            as: member,
          })
          .fails(1),
    );
    await step("A Member can't make an audit token", async () => {
      expect(memberAudit.stderr).toContain(
        "This account's tokens read project data, not the audit log.",
      );
    });
  },
);
