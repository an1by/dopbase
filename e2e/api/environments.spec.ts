import { grant } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { expectError, expectOk } from "./support.ts";

// Members (for protected-environment checks) need RBAC.
const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "environment list, read, rename and delete",
  {
    tag: "@environments",
    annotation: about(
      "Environments are listed for all projects or one project, read by id, renamed, and deleted with a count of the secrets and tokens they took along.",
    ),
  },
  async () => {
    const project = await app.make.project();
    const other = await app.make.environment();
    const env = await app.make.environment({ project, name: "staging" });
    await app.make.secret(env, "API_KEY");
    await step(
      "GET /environments lists both projects' environments",
      async () => {
        const ids = expectOk(await app.api.get("/environments")).map(
          (e: { id: string }) => e.id,
        );
        expect(ids).toEqual(expect.arrayContaining([env.id, other.id]));
      },
    );
    await step(
      "GET /environments?project= lists only that project's",
      async () => {
        const list = expectOk(
          await app.api.get(`/environments?project=${project.name}`),
        );
        expect(list.map((e: { id: string }) => e.id)).toEqual([env.id]);
      },
    );
    await step("GET /environments/{id} shows its secret count", async () => {
      expect(
        expectOk(await app.api.get(`/environments/${env.id}`)),
      ).toMatchObject({
        id: env.id,
        name: "staging",
        secretCount: 1,
        projectName: project.name,
      });
    });
    await step("PATCH /environments/{id} renames it to qa", async () => {
      expect(
        expectOk(await app.api.patch(`/environments/${env.id}`, { name: "qa" }))
          .name,
      ).toBe("qa");
    });
    await step("PATCH /environments/{id} with a bad name is 422", async () => {
      expectError(
        await app.api.patch(`/environments/${env.id}`, { name: "Q A" }),
        422,
        "ENVIRONMENT_NAME_INVALID",
      );
    });
    await app.make.environment({ project, name: "prod" });
    await step(
      "PATCH /environments/{id} onto a sibling's name is 409",
      async () => {
        expect(
          (await app.api.patch(`/environments/${env.id}`, { name: "prod" }))
            .status,
        ).toBe(409);
      },
    );
    await step(
      "DELETE /environments/{id} reports one secret removed",
      async () => {
        expect(
          expectOk(await app.api.delete(`/environments/${env.id}`)).affected,
        ).toEqual({ projects: 0, environments: 1, secrets: 1, tokens: 0 });
      },
    );
    await step(
      "GET, PATCH and DELETE the deleted environment are 404",
      async () => {
        expectError(
          await app.api.get(`/environments/${env.id}`),
          404,
          "ENVIRONMENT_NOT_FOUND",
        );
        expectError(
          await app.api.patch(`/environments/${env.id}`, { name: "back" }),
          404,
          "ENVIRONMENT_NOT_FOUND",
        );
        expectError(
          await app.api.delete(`/environments/${env.id}`),
          404,
          "ENVIRONMENT_NOT_FOUND",
        );
      },
    );
    await step("Without a session environment routes are 401", async () => {
      const anonymous = await app.anonymousApi();
      expectError(await anonymous.get("/environments"), 401);
      expectError(await anonymous.get(`/environments/${other.id}`), 401);
    });
  },
);

test(
  "resolve an environment by project and name",
  {
    tag: "@environments",
    annotation: about(
      "GET /environments/resolve turns project/environment into the environment record, and an unknown name is 404.",
    ),
  },
  async () => {
    const env = await app.make.environment({ name: "prod" });
    await step(
      "GET /environments/resolve?reference={project}/prod",
      async () => {
        const resolved = expectOk(
          await app.api.get(`/environments/resolve?reference=${env.ref}`),
        );
        expect(resolved).toMatchObject({ id: env.id, name: "prod" });
      },
    );
    await step("Resolving an unknown environment is 404", async () => {
      expectError(
        await app.api.get(
          `/environments/resolve?reference=${env.projectName}/nowhere`,
        ),
        404,
        "ENVIRONMENT_NOT_FOUND",
      );
    });
    await step("Resolving an unknown project is 404", async () => {
      expect(
        (await app.api.get("/environments/resolve?reference=nope/prod")).status,
      ).toBe(404);
    });
    await step("Resolving without a session is 401", async () => {
      expectError(
        await (
          await app.anonymousApi()
        ).get(`/environments/resolve?reference=${env.ref}`),
        401,
      );
    });
  },
);

test(
  "protected environments stop project grants below project manager",
  {
    tag: "@environments",
    annotation: about(
      "Marking an environment protected hides it from a Member whose write grant is on the project; an environment grant still reaches it, and a project-level manager can't lock themselves out.",
    ),
  },
  async () => {
    const project = await app.make.project();
    const env = await app.make.environment({ project, name: "prod" });
    const member = await app.make.user();
    const api = await app.apiAs(member);
    await grant(app, member, "manage", { project: project.id });
    await step("Before protection the Member sees it at manage", async () => {
      expect(expectOk(await api.get(`/environments/${env.id}`)).level).toBe(
        "manage",
      );
    });
    await step(
      "The Member can't protect it: that would lock them out (409)",
      async () => {
        expectError(
          await api.patch(`/environments/${env.id}`, { protected: true }),
          409,
          "ENVIRONMENT_PROTECT_LOCKOUT",
        );
        expect(
          expectOk(await api.get(`/environments/${env.id}`)).protected,
        ).toBe(false);
      },
    );
    await step("PATCH /environments/{id} protected=true as root", async () => {
      expect(
        expectOk(
          await app.api.patch(`/environments/${env.id}`, { protected: true }),
        ).protected,
      ).toBe(true);
    });
    await step("Now the Member gets 404 and doesn't list it", async () => {
      expectError(
        await api.get(`/environments/${env.id}`),
        404,
        "ENVIRONMENT_NOT_FOUND",
      );
      const ids = expectOk(await api.get("/environments")).map(
        (e: { id: string }) => e.id,
      );
      expect(ids).not.toContain(env.id);
    });
    await grant(app, member, "read", { environment: env.id });
    await step("An environment grant reaches it at read", async () => {
      expect(expectOk(await api.get(`/environments/${env.id}`)).level).toBe(
        "read",
      );
    });
    await step(
      "At read the Member can't rename or delete it (403)",
      async () => {
        expectError(
          await api.patch(`/environments/${env.id}`, { name: "live" }),
          403,
          "AUTHORIZATION_DENIED",
        );
        expectError(
          await api.delete(`/environments/${env.id}`),
          403,
          "AUTHORIZATION_DENIED",
        );
      },
    );
  },
);
