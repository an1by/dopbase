import { grant, tempDir } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";

// Members and personal tokens need people management turned on.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "access shows what the signed-in account reaches",
  {
    tag: "@access",
    annotation: about(
      "`dopbase access` lists a member's role and grants, root's role, and `--project` shows who can reach a project.",
    ),
  },
  async () => {
    const member = await app.make.user({ role: "Member" });
    const project = await app.make.project();
    await grant(app, member, "read", { project: project.name });
    const json = await step("dopbase --json access as the member", async () =>
      app.cli(["--json", "access"], { as: member }).json(),
    );
    await step(
      "It shows the Member role and a read grant on the project",
      async () => {
        expect(json.email).toBe(member.email);
        expect(json.roleName).toBe("Member");
        expect(json.token).toBeNull();
        const onProject = json.grants.find(
          (g: any) => g.scopeLabel === project.name,
        );
        expect(onProject.level).toBe("read");
      },
    );
    const human = await step("dopbase access as the member", async () =>
      app.cli(["access"], { as: member }).stdout(),
    );
    await step("It reads Account, Role and the grant table", async () => {
      expect(human).toMatch(new RegExp(`Account:\\s+${member.email}`));
      expect(human).toMatch(/Role:\s+Member \(up to /);
      expect(human).toMatch(/WHERE\s+LEVEL\s+FROM/);
      expect(human).toContain(project.name);
    });
    const root = await step("dopbase --json access as root", async () =>
      app.cli(["--json", "access"]).json(),
    );
    await step("Root's role is Root", async () => {
      expect(root.roleName).toBe("Root");
    });
    const report = await step(
      `dopbase --json access --project ${project.name}`,
      async () =>
        app.cli(["--json", "access", "--project", project.name]).json(),
    );
    await step("The project report lists the member's grant", async () => {
      expect(report.project.name).toBe(project.name);
      expect(report.grants.map((g: any) => g.principalLabel)).toContain(
        member.email,
      );
    });
    const unknown = await step("dopbase access --user usr_nope", async () =>
      app.cli(["access", "--user", "usr_nope"]).fails(1),
    );
    await step("An unknown account id is refused", async () => {
      expect(unknown.stderr).toMatch(/^Error: /);
    });
  },
);

test(
  "access shows what the personal token in DOPBASE_TOKEN reaches",
  {
    tag: ["@access", "@tokens"],
    annotation: about(
      "With a scoped personal token in DOPBASE_TOKEN, `dopbase access` names the token, its level and scope, under the account that owns it.",
    ),
  },
  async () => {
    const member = await app.make.user({ role: "Member" });
    const project = await app.make.project();
    await grant(app, member, "write", { project: project.name });
    const created = await app
      .cli(
        [
          "--json",
          "token",
          "personal",
          "create",
          "--name",
          "reader",
          "--level",
          "read",
          "--project",
          project.name,
        ],
        { as: member },
      )
      .json();
    const env = {
      HOME: app.server.root,
      DOPBASE_URL: app.url,
      DOPBASE_TOKEN: created.plaintextToken,
      DOPBASE_DATA_DIR: await tempDir(app, "token"),
    };
    const json = await step(
      "DOPBASE_TOKEN=dpp_… dopbase --json access",
      async () => app.cliRaw(["--json", "access"], { env }).json(),
    );
    await step("It names the token, level read, on the project", async () => {
      expect(json.email).toBe(member.email);
      expect(json.token.name).toBe("reader");
      expect(json.token.level).toBe("read");
      expect(json.token.scopeLabel).toBe(project.name);
    });
    const human = await step("DOPBASE_TOKEN=dpp_… dopbase access", async () =>
      app.cliRaw(["access"], { env }).stdout(),
    );
    await step(
      "It reads Token: reader, up to read on the project",
      async () => {
        expect(human).toMatch(
          new RegExp(`Token:\\s+reader, up to read on ${project.name}`),
        );
      },
    );
    const status = await step(
      "DOPBASE_TOKEN=dpp_… dopbase --json status",
      async () => app.cliRaw(["--json", "status"], { env }).json(),
    );
    await step(
      "client status calls it a personal token from the environment",
      async () => {
        expect(status.identity).toBe("personal_token");
        expect(status.authentication).toBe("environment");
      },
    );
  },
);
