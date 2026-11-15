import { grant } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { expectError, expectOk } from "./support.ts";

// Members (for the 403 and 404 cases) need RBAC.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "project create, read, list, rename and delete",
  {
    tag: "@projects",
    annotation: about(
      "Root creates a project, finds it by name and id, renames it, and deleting it removes its environments, secrets and tokens and reports the counts.",
    ),
  },
  async () => {
    const name = app.uniq("shop");
    const project = await step(`POST /projects ${name}`, async () => {
      const created = expectOk(await app.api.post("/projects", { name }), 201);
      expect(created).toMatchObject({ name, level: "project_manager" });
      expect(created.id).toMatch(/^prj_/);
      return created;
    });
    await step("GET /projects lists it", async () => {
      const list = expectOk(await app.api.get("/projects"));
      expect(list.map((p: { name: string }) => p.name)).toContain(name);
    });
    await step(
      "GET /projects/{name} and /projects/{id} both find it",
      async () => {
        expect(expectOk(await app.api.get(`/projects/${name}`)).id).toBe(
          project.id,
        );
        expect(
          expectOk(await app.api.get(`/projects/${project.id}`)).name,
        ).toBe(name);
      },
    );
    const renamed = `${name}-v2`;
    await step(`PATCH /projects/{id} renames it to ${renamed}`, async () => {
      expect(
        expectOk(
          await app.api.patch(`/projects/${project.id}`, { name: renamed }),
        ).name,
      ).toBe(renamed);
      expectError(
        await app.api.get(`/projects/${name}`),
        404,
        "PROJECT_NOT_FOUND",
      );
    });
    const env = await app.make.environment({
      project: { ...project, name: renamed },
    });
    await app.make.secret(env, "API_KEY");
    await step("DELETE /projects/{id} reports what went with it", async () => {
      const deleted = expectOk(await app.api.delete(`/projects/${project.id}`));
      expect(deleted.affected).toEqual({
        projects: 1,
        environments: 1,
        secrets: 1,
        tokens: 0,
      });
    });
    await step("The project and its environment are gone", async () => {
      expectError(
        await app.api.get(`/projects/${project.id}`),
        404,
        "PROJECT_NOT_FOUND",
      );
      expectError(
        await app.api.get(`/environments/${env.id}`),
        404,
        "ENVIRONMENT_NOT_FOUND",
      );
    });
  },
);

test(
  "project validation and conflicts",
  {
    tag: "@projects",
    annotation: about(
      "Bad names are 422, a duplicate name is 409, renaming onto another project's name is 409, and unknown projects are 404.",
    ),
  },
  async () => {
    const first = await app.make.project();
    const second = await app.make.project();
    await step("POST /projects with an invalid name is 422", async () => {
      expectError(
        await app.api.post("/projects", { name: "Not A Slug!" }),
        422,
        "PROJECT_NAME_INVALID",
      );
    });
    await step("POST /projects with a taken name is 409", async () => {
      expectError(
        await app.api.post("/projects", { name: first.name }),
        409,
        "PROJECT_ALREADY_EXISTS",
      );
    });
    await step("PATCH /projects/{id} onto a taken name is 409", async () => {
      expectError(
        await app.api.patch(`/projects/${second.id}`, { name: first.name }),
        409,
        "PROJECT_ALREADY_EXISTS",
      );
    });
    await step("PATCH /projects/{id} with an invalid name is 422", async () => {
      expectError(
        await app.api.patch(`/projects/${second.id}`, { name: "UPPER" }),
        422,
        "PROJECT_NAME_INVALID",
      );
    });
    await step("GET, PATCH and DELETE an unknown project are 404", async () => {
      expectError(
        await app.api.get("/projects/no-such-project"),
        404,
        "PROJECT_NOT_FOUND",
      );
      expectError(
        await app.api.patch("/projects/no-such-project", { name: "whatever" }),
        404,
        "PROJECT_NOT_FOUND",
      );
      expectError(
        await app.api.delete("/projects/no-such-project"),
        404,
        "PROJECT_NOT_FOUND",
      );
    });
  },
);

test(
  "project access is checked",
  {
    tag: "@projects",
    annotation: about(
      "Without a session project routes are 401; a Member can't create projects (403), doesn't see ungranted ones (404), and needs project manager to rename or delete.",
    ),
  },
  async () => {
    const project = await app.make.project();
    const member = await app.make.user();
    const api = await app.apiAs(member);
    const anonymous = await app.anonymousApi();
    await step(
      "GET /projects and POST /projects without a session are 401",
      async () => {
        expectError(await anonymous.get("/projects"), 401);
        expectError(
          await anonymous.post("/projects", { name: app.uniq("x") }),
          401,
        );
      },
    );
    await step("POST /projects as a Member is 403", async () => {
      expectError(
        await api.post("/projects", { name: app.uniq("member") }),
        403,
        "AUTHORIZATION_DENIED",
      );
    });
    await step("A Member with no grant doesn't see the project", async () => {
      const list = expectOk(await api.get("/projects"));
      expect(list.map((p: { id: string }) => p.id)).not.toContain(project.id);
      expectError(
        await api.get(`/projects/${project.id}`),
        404,
        "PROJECT_NOT_FOUND",
      );
    });
    await grant(app, member, "write", { project: project.id });
    await step("With a write grant the Member sees it at write", async () => {
      expect(expectOk(await api.get(`/projects/${project.id}`)).level).toBe(
        "write",
      );
    });
    await step("PATCH and DELETE /projects/{id} at write are 403", async () => {
      expectError(
        await api.patch(`/projects/${project.id}`, { name: app.uniq("nope") }),
        403,
        "AUTHORIZATION_DENIED",
      );
      expectError(
        await api.delete(`/projects/${project.id}`),
        403,
        "AUTHORIZATION_DENIED",
      );
    });
    await step(
      "A Member's role caps grants below project manager (422)",
      async () => {
        const capped = await app.api.send(
          "PUT",
          "/grants",
          {
            principalType: "user",
            principalId: member.id,
            scopeType: "project",
            scope: project.id,
            level: "project_manager",
          },
          { record: false },
        );
        expect(capped.status).toBe(422);
      },
    );
    // Admins reach project manager, which renames and deletes.
    const admin = await app.make.user({ role: "Admin" });
    await grant(app, admin, "project_manager", { project: project.id });
    const renamed = app.uniq("managed");
    await step("An Admin who is project manager renames it", async () => {
      const adminApi = await app.apiAs(admin);
      expect(
        expectOk(
          await adminApi.patch(`/projects/${project.id}`, { name: renamed }),
        ).name,
      ).toBe(renamed);
    });
  },
);

test(
  "projects/init creates a project, an environment and its secrets",
  {
    tag: "@projects",
    annotation: about(
      "POST /projects/init makes the project and first environment and stores the given secrets as version 1; bad input is 422 and an existing project 409.",
    ),
  },
  async () => {
    const projectName = app.uniq("init");
    const values = { DATABASE_URL: app.value(), API_KEY: app.value() };
    const init = await step(
      `POST /projects/init ${projectName}/dev with 2 secrets`,
      async () => {
        const result = expectOk(
          await app.api.post("/projects/init", {
            projectName,
            environmentName: "dev",
            entries: Object.entries(values).map(([key, value]) => ({
              key,
              value,
            })),
          }),
          201,
        );
        expect(result.project.name).toBe(projectName);
        expect(result.secretCount).toBe(2);
        return result;
      },
    );
    await step("The new environment holds both values", async () => {
      for (const [key, value] of Object.entries(values)) {
        const revealed = await app.api.must(
          "POST",
          `/environments/${init.environmentId}/secrets/${key}/reveal`,
          {},
          { record: false },
        );
        expect(revealed).toMatchObject({ key, value, version: 1 });
      }
    });
    await step(
      "POST /projects/init for an existing project is 409",
      async () => {
        expectError(
          await app.api.post("/projects/init", {
            projectName,
            environmentName: "staging",
            entries: [],
          }),
          409,
          "PROJECT_ALREADY_EXISTS",
        );
      },
    );
    await step("POST /projects/init with a duplicate key is 422", async () => {
      const dup = app.value();
      expectError(
        await app.api.post("/projects/init", {
          projectName: app.uniq("dup"),
          environmentName: "dev",
          entries: [
            { key: "SAME", value: dup },
            { key: "SAME", value: dup },
          ],
        }),
        422,
        "IMPORT_DUPLICATE_KEY",
      );
    });
    await step(
      "POST /projects/init with a bad environment name is 422",
      async () => {
        expectError(
          await app.api.post("/projects/init", {
            projectName: app.uniq("bad"),
            environmentName: "Bad Env",
            entries: [],
          }),
          422,
          "ENVIRONMENT_NAME_INVALID",
        );
      },
    );
  },
);

test(
  "project environments and access list",
  {
    tag: "@projects",
    annotation: about(
      "POST /projects/{ref}/environments adds environments, and GET /projects/{ref}/access lists them with the grants on the project.",
    ),
  },
  async () => {
    const project = await app.make.project();
    const member = await app.make.user();
    await step(
      "POST /projects/{ref}/environments dev and prod (protected)",
      async () => {
        const dev = expectOk(
          await app.api.post(`/projects/${project.name}/environments`, {
            name: "dev",
          }),
          201,
        );
        expect(dev).toMatchObject({
          name: "dev",
          protected: false,
          projectId: project.id,
        });
        const prod = expectOk(
          await app.api.post(`/projects/${project.name}/environments`, {
            name: "prod",
            protected: true,
          }),
          201,
        );
        expect(prod.protected).toBe(true);
      },
    );
    await step(
      "POST /projects/{ref}/environments with a taken name is 409",
      async () => {
        expect(
          (
            await app.api.post(`/projects/${project.name}/environments`, {
              name: "dev",
            })
          ).status,
        ).toBe(409);
      },
    );
    await step(
      "POST /projects/{ref}/environments with a bad name is 422",
      async () => {
        expectError(
          await app.api.post(`/projects/${project.name}/environments`, {
            name: "Dev Env",
          }),
          422,
          "ENVIRONMENT_NAME_INVALID",
        );
      },
    );
    await step(
      "POST /projects/{ref}/environments on an unknown project is 404",
      async () => {
        expectError(
          await app.api.post("/projects/no-such-project/environments", {
            name: "dev",
          }),
          404,
          "PROJECT_NOT_FOUND",
        );
      },
    );
    await grant(app, member, "read", { project: project.id });
    await step(
      "GET /projects/{ref}/access lists environments and grants",
      async () => {
        const access = expectOk(
          await app.api.get(`/projects/${project.name}/access`),
        );
        expect(access.project.id).toBe(project.id);
        expect(
          access.environments.map((e: { name: string }) => e.name).sort(),
        ).toEqual(["dev", "prod"]);
        expect(access.grants).toEqual([
          expect.objectContaining({
            principalId: member.id,
            level: "read",
            scopeType: "project",
          }),
        ]);
      },
    );
    await step("A Member at read can't add an environment (403)", async () => {
      const api = await app.apiAs(member);
      expectError(
        await api.post(`/projects/${project.name}/environments`, {
          name: "qa",
        }),
        403,
        "AUTHORIZATION_DENIED",
      );
    });
    await step(
      "GET /projects/{ref}/access for an unknown project is 404",
      async () => {
        expectError(
          await app.api.get("/projects/no-such-project/access"),
          404,
          "PROJECT_NOT_FOUND",
        );
      },
    );
  },
);
