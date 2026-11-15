import { about, expect, step, test, useServer } from "../harness/index.ts";

const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "project create, list, show, rename and delete",
  {
    tag: "@projects",
    annotation: about(
      "A project made with `project create` shows in `project list` and `project show`, keeps its id through `project rename`, and `project delete --yes` removes it with its environments.",
    ),
  },
  async () => {
    const name = app.uniq("billing");
    const renamed = app.uniq("payments");
    const created = await step(
      `dopbase --json project create ${name}`,
      async () => app.cli(["--json", "project", "create", name]).json(),
    );
    await step("It returns the new project with a prj_ id", async () => {
      expect(created.name).toBe(name);
      expect(created.id).toMatch(/^prj_/);
    });
    const second = app.uniq("audit");
    const human = await step(`dopbase project create ${second}`, async () =>
      app.cli(["project", "create", second]).stdout(),
    );
    await step("It says Created project <name> (<id>)", async () => {
      expect(human).toMatch(/^Created project audit-[0-9a-f]+ \(prj_\w+\)\.$/);
    });

    const list = await step("dopbase --json project list", async () =>
      app.cli(["--json", "project", "list"]).json<any[]>(),
    );
    await step("The list holds the project", async () => {
      expect(list.map((p) => p.id)).toContain(created.id);
    });
    const table = await step("dopbase project list", async () =>
      app.cli(["project", "list"]).stdout(),
    );
    await step("The table has NAME, ID, UPDATED and a count", async () => {
      expect(table).toMatch(/^NAME\s+ID\s+UPDATED/);
      expect(table).toContain(name);
      expect(table).toMatch(/\d+ project\(s\)$/);
    });

    const shown = await step(`dopbase project show ${name}`, async () =>
      app.cli(["project", "show", name]).stdout(),
    );
    await step("It shows the name and id", async () => {
      expect(shown).toMatch(new RegExp(`Name:\\s+${name}`));
      expect(shown).toMatch(new RegExp(`ID:\\s+${created.id}`));
    });
    const byId = await step(
      `dopbase --json project show ${created.id}`,
      async () => app.cli(["--json", "project", "show", created.id]).json(),
    );
    await step("Showing by id finds the same project", async () => {
      expect(byId.name).toBe(name);
    });

    const afterRename = await step(
      `dopbase --json project rename ${name} ${renamed}`,
      async () =>
        app.cli(["--json", "project", "rename", name, renamed]).json(),
    );
    await step("The id stays and the name changes", async () => {
      expect(afterRename.id).toBe(created.id);
      expect(afterRename.name).toBe(renamed);
      const project = await app.api.must("GET", `/projects/${created.id}`);
      expect(project.name).toBe(renamed);
    });

    await app.make.environment({ project: { id: created.id, name: renamed } });
    const deleted = await step(
      `dopbase project delete ${renamed} --yes`,
      async () => app.cli(["project", "delete", renamed, "--yes"]).stdout(),
    );
    await step(
      "It says Deleted and counts the environment it took",
      async () => {
        expect(deleted).toContain(`Deleted project ${renamed}.`);
        expect(deleted).toMatch(/Environments:\s+1/);
      },
    );
    await step("The API no longer finds it", async () => {
      expect((await app.api.get(`/projects/${created.id}`)).status).toBe(404);
    });
  },
);

test(
  "a duplicate project name is refused",
  {
    tag: "@projects",
    annotation: about(
      "`project create` with a name that is taken fails and leaves one project with that name.",
    ),
  },
  async () => {
    const project = await app.make.project();
    const result = await step(
      `dopbase project create ${project.name} again`,
      async () => app.cli(["project", "create", project.name]).fails(1),
    );
    await step("It fails with a conflict error", async () => {
      expect(result.stderr).toMatch(/^Error: \w+: /);
      expect(result.stderr).toMatch(/exists|taken|already/i);
    });
    await step("Only one project has the name", async () => {
      const list = await app.cli(["--json", "project", "list"]).json<any[]>();
      expect(list.filter((p) => p.name === project.name)).toHaveLength(1);
    });
  },
);

test(
  "show and delete of a missing project fail",
  {
    tag: "@projects",
    annotation: about(
      "`project show` and `project delete` for a name that doesn't exist exit 1 with PROJECT_NOT_FOUND, and delete without --yes needs a terminal.",
    ),
  },
  async () => {
    const missing = app.uniq("ghost");
    const show = await step(`dopbase project show ${missing}`, async () =>
      app.cli(["project", "show", missing]).fails(1),
    );
    await step("It says the project was not found", async () => {
      expect(show.stderr).toContain("PROJECT_NOT_FOUND");
    });
    const json = await step(
      `dopbase --json project show ${missing}`,
      async () => app.cli(["--json", "project", "show", missing]).fails(1),
    );
    await step("With --json the error is a JSON object", async () => {
      const body = JSON.parse(json.stderr);
      expect(body.success).toBe(false);
      expect(body.error.CLI_ERROR).toContain("PROJECT_NOT_FOUND");
    });
    const remove = await step(
      `dopbase project delete ${missing} --yes`,
      async () => app.cli(["project", "delete", missing, "--yes"]).fails(1),
    );
    await step("Delete fails the same way", async () => {
      expect(remove.stderr).toContain("PROJECT_NOT_FOUND");
    });

    const project = await app.make.project();
    const unconfirmed = await step(
      `dopbase project delete ${project.name} without --yes`,
      async () => app.cli(["project", "delete", project.name]).fails(1),
    );
    await step("It asks for --yes and keeps the project", async () => {
      expect(unconfirmed.stderr).toContain(
        "confirmation is required. Pass --yes for non-interactive use",
      );
      expect((await app.api.get(`/projects/${project.id}`)).status).toBe(200);
    });
  },
);

test(
  "a member only sees projects they were given",
  {
    tag: "@projects",
    annotation: about(
      "Signed in as a Member with no grants, `project list` is empty and `project create` is refused.",
    ),
  },
  async () => {
    const member = await app.make.user({ role: "Member" });
    const hidden = await app.make.project();
    const list = await step(
      "dopbase --json project list as the member",
      async () =>
        app.cli(["--json", "project", "list"], { as: member }).json<any[]>(),
    );
    await step("Root's project is not in the list", async () => {
      expect(list.map((p) => p.id)).not.toContain(hidden.id);
    });
    const created = await step(
      "dopbase project create as the member",
      async () =>
        app
          .cli(["project", "create", app.uniq("mine")], { as: member })
          .fails(1),
    );
    await step("It is refused", async () => {
      expect(created.stderr).toMatch(/^Error: \w+: /);
    });
  },
);
