import {
  about,
  expect,
  step,
  test,
  useServer,
  type User,
} from "../harness/index.ts";
import type { ApiClient } from "../harness/api.ts";
import {
  ALL_FEATURES,
  expectError,
  expectOk,
  freshSession,
  QUIET,
} from "./support.ts";

const app = useServer({ env: ALL_FEATURES });

/** The level `api` has on an environment, or "hidden" when it gets 404. */
async function levelOn(api: ApiClient, envId: string): Promise<string> {
  const result = await api.send(
    "GET",
    `/environments/${envId}`,
    undefined,
    QUIET,
  );
  if (result.status === 404) return "hidden";
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.data.level;
}

function setGrant(
  user: User,
  level: string,
  scope: { scopeType: string; scope?: string },
) {
  return app.api.put("/grants", {
    principalType: "user",
    principalId: user.id,
    level,
    ...scope,
  });
}

test(
  "grants on all projects, one project and one environment",
  {
    tag: "@access",
    annotation: about(
      "PUT /grants gives a Member read on all projects, write on one project and manage on one environment; each shows up in their access and on the environments they reach.",
    ),
  },
  async () => {
    const member = await app.make.user();
    const api = await app.apiAs(member);
    const elsewhere = await app.make.environment();
    const project = await app.make.project();
    const dev = await app.make.environment({ project, name: "dev" });
    const prod = await app.make.environment({ project, name: "prod" });
    await step("Before any grant the Member sees none of them", async () => {
      expect(await levelOn(api, elsewhere.id)).toBe("hidden");
      expect(await levelOn(api, dev.id)).toBe("hidden");
    });
    await step("PUT /grants read on all projects", async () => {
      const saved = expectOk(
        await setGrant(member, "read", { scopeType: "all" }),
      );
      expect(saved).toMatchObject({
        scopeType: "all",
        level: "read",
        principalId: member.id,
      });
      expect(await levelOn(api, elsewhere.id)).toBe("read");
    });
    await step(`PUT /grants write on project ${project.name}`, async () => {
      expectOk(
        await setGrant(member, "write", {
          scopeType: "project",
          scope: project.name,
        }),
      );
      expect(await levelOn(api, dev.id)).toBe("write");
      expect(await levelOn(api, elsewhere.id)).toBe("read");
    });
    await step("PUT /grants manage on the prod environment", async () => {
      const saved = expectOk(
        await setGrant(member, "manage", {
          scopeType: "environment",
          scope: prod.id,
        }),
      );
      expect(saved).toMatchObject({
        scopeType: "environment",
        scopeId: prod.id,
      });
      expect(await levelOn(api, prod.id)).toBe("manage");
      expect(await levelOn(api, dev.id)).toBe("write");
    });
    await step(
      "PUT /grants again on the same scope replaces the level",
      async () => {
        expectOk(
          await setGrant(member, "metadata", {
            scopeType: "environment",
            scope: prod.id,
          }),
        );
        expect(await levelOn(api, prod.id)).toBe("metadata");
        const access = await app.api.must(
          "GET",
          `/users/${member.id}/access`,
          undefined,
          QUIET,
        );
        expect(access.grants).toHaveLength(3);
      },
    );
  },
);

test(
  "the most specific grant wins, capped by the role ceiling",
  {
    tag: "@access",
    annotation: about(
      "An environment grant overrides the project grant, which overrides the all-projects one, even when it is lower; and a role's ceiling caps whatever the grants say.",
    ),
  },
  async () => {
    const member = await app.make.user();
    const api = await app.apiAs(member);
    const project = await app.make.project();
    const env = await app.make.environment({ project });
    await app.make.secret(env, "API_KEY");
    await setGrant(member, "manage", { scopeType: "all" });
    await step("All-projects manage gives manage", async () => {
      expect(await levelOn(api, env.id)).toBe("manage");
    });
    await setGrant(member, "read", { scopeType: "project", scope: project.id });
    await step("A project grant of read narrows it to read", async () => {
      expect(await levelOn(api, env.id)).toBe("read");
    });
    await setGrant(member, "metadata", {
      scopeType: "environment",
      scope: env.id,
    });
    await step(
      "An environment grant of metadata narrows it again",
      async () => {
        expect(await levelOn(api, env.id)).toBe("metadata");
        expectError(
          await api.post(`/environments/${env.id}/secrets/API_KEY/reveal`),
          403,
          "AUTHORIZATION_DENIED",
        );
      },
    );
    await setGrant(member, "none", { scopeType: "environment", scope: env.id });
    await step(
      "An environment grant of none hides it despite the others",
      async () => {
        expect(await levelOn(api, env.id)).toBe("hidden");
      },
    );
    const auditor = await app.make.user({ role: "Auditor" });
    const auditorApi = await app.apiAs(auditor);
    await step("A grant above the role ceiling is refused (422)", async () => {
      expectError(
        await setGrant(auditor, "write", {
          scopeType: "project",
          scope: project.id,
        }),
        422,
        "GRANT_LEVEL_INVALID",
      );
    });
    await setGrant(member, "write", {
      scopeType: "environment",
      scope: env.id,
    });
    await step(
      "Changing the role caps an existing grant at the new ceiling",
      async () => {
        expect(await levelOn(api, env.id)).toBe("write");
        await app.api.must(
          "PATCH",
          `/users/${member.id}`,
          { roleId: "rol_auditor" },
          QUIET,
        );
        // A role change ends the person's sessions, so sign in again.
        const again = await freshSession(app, member);
        expect(await levelOn(again, env.id)).toBe("metadata");
        await again.dispose();
      },
    );
    await step(
      "An Auditor with a metadata grant sees names, not values",
      async () => {
        expectOk(
          await setGrant(auditor, "metadata", {
            scopeType: "project",
            scope: project.id,
          }),
        );
        expect(await levelOn(auditorApi, env.id)).toBe("metadata");
      },
    );
  },
);

test(
  "an Admin made by root starts as project manager on all projects",
  {
    tag: "@access",
    annotation: about(
      "Root's new Admins get an all-projects project manager grant, so they reach every environment at manage; a Member starts with nothing, and moving the Admin to Member drops it.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    const admin = await app.make.user({ role: "Admin" });
    const member = await app.make.user();
    await step(
      "GET /users/{id}/access shows the all-projects grant",
      async () => {
        const access = expectOk(await app.api.get(`/users/${admin.id}/access`));
        expect(access.grants).toEqual([
          expect.objectContaining({
            scopeType: "all",
            level: "project_manager",
          }),
        ]);
        const memberAccess = expectOk(
          await app.api.get(`/users/${member.id}/access`),
        );
        expect(memberAccess.grants).toEqual([]);
      },
    );
    await step(
      "The Admin reaches an existing environment at manage",
      async () => {
        expect(await levelOn(await app.apiAs(admin), env.id)).toBe("manage");
      },
    );
    await step(
      "Changing the Admin to Member removes the starting grant",
      async () => {
        await app.api.must(
          "PATCH",
          `/users/${admin.id}`,
          { roleId: "rol_member" },
          QUIET,
        );
        const access = expectOk(await app.api.get(`/users/${admin.id}/access`));
        expect(access.grants).toEqual([]);
      },
    );
  },
);

test(
  "revoke a grant",
  {
    tag: "@access",
    annotation: about(
      "DELETE /grants/{id} takes the access away at once; a second delete is 404.",
    ),
  },
  async () => {
    const member = await app.make.user();
    const api = await app.apiAs(member);
    const env = await app.make.environment();
    const saved = expectOk(
      await setGrant(member, "write", {
        scopeType: "environment",
        scope: env.id,
      }),
    );
    await step(
      "With the grant the Member reaches the environment",
      async () => {
        expect(await levelOn(api, env.id)).toBe("write");
      },
    );
    await step("DELETE /grants/{id}", async () => {
      expectOk(await app.api.delete(`/grants/${saved.id}`));
    });
    await step("The environment is hidden again", async () => {
      expect(await levelOn(api, env.id)).toBe("hidden");
    });
    await step("DELETE /grants/{id} again is 404", async () => {
      expectError(
        await app.api.delete(`/grants/${saved.id}`),
        404,
        "GRANT_NOT_FOUND",
      );
    });
  },
);

test(
  "grant validation and who may grant",
  {
    tag: "@access",
    annotation: about(
      "Bad scope and level combinations are 422, unknown targets 404, no session 401; a Member can't grant, an Admin can't grant on all projects or to themselves.",
    ),
  },
  async () => {
    const member = await app.make.user();
    const project = await app.make.project();
    const env = await app.make.environment({ project });
    await step("Project manager on one environment is 422", async () => {
      expectError(
        await setGrant(member, "project_manager", {
          scopeType: "environment",
          scope: env.id,
        }),
        422,
        "GRANT_LEVEL_INVALID",
      );
    });
    await step("None on a project is 422", async () => {
      expectError(
        await setGrant(member, "none", {
          scopeType: "project",
          scope: project.id,
        }),
        422,
        "GRANT_LEVEL_INVALID",
      );
    });
    await step("A project scope without a project is 422", async () => {
      expectError(
        await setGrant(member, "read", { scopeType: "project" }),
        422,
        "GRANT_SCOPE_INVALID",
      );
    });
    await step("An unknown project or environment is 404", async () => {
      expectError(
        await setGrant(member, "read", {
          scopeType: "project",
          scope: "no-such-project",
        }),
        404,
        "PROJECT_NOT_FOUND",
      );
      expectError(
        await setGrant(member, "read", {
          scopeType: "environment",
          scope: "env_000000",
        }),
        404,
        "ENVIRONMENT_NOT_FOUND",
      );
    });
    await step("A grant to an unknown person is refused", async () => {
      const result = await app.api.put("/grants", {
        principalType: "user",
        principalId: "usr_unknown",
        level: "read",
        scopeType: "project",
        scope: project.id,
      });
      expectError(result, 422, "GRANT_PRINCIPAL_INVALID");
    });
    await step("Grant routes without a session are 401", async () => {
      const anonymous = await app.anonymousApi();
      expectError(
        await anonymous.put("/grants", {
          principalType: "user",
          principalId: member.id,
          level: "read",
          scopeType: "all",
        }),
        401,
      );
      expectError(await anonymous.delete("/grants/grt_x"), 401);
    });
    await app.api.must(
      "PUT",
      "/grants",
      {
        principalType: "user",
        principalId: member.id,
        level: "write",
        scopeType: "project",
        scope: project.id,
      },
      QUIET,
    );
    await step(
      "A Member with write on the project can't grant on it (403)",
      async () => {
        const api = await app.apiAs(member);
        const other = await app.make.user();
        expect(
          (
            await api.put("/grants", {
              principalType: "user",
              principalId: other.id,
              level: "read",
              scopeType: "project",
              scope: project.id,
            })
          ).status,
        ).toBe(403);
      },
    );
    const admin = await app.make.user({ role: "Admin" });
    const adminApi = await app.apiAs(admin);
    await step("An Admin can't grant on all projects (403)", async () => {
      expectError(
        await adminApi.put("/grants", {
          principalType: "user",
          principalId: member.id,
          level: "read",
          scopeType: "all",
        }),
        403,
        "AUTHORIZATION_DENIED",
      );
    });
    await app.api.must(
      "PUT",
      "/grants",
      {
        principalType: "user",
        principalId: admin.id,
        level: "project_manager",
        scopeType: "project",
        scope: project.id,
      },
      QUIET,
    );
    await step("An Admin who manages the project grants on it", async () => {
      expectOk(
        await adminApi.put("/grants", {
          principalType: "user",
          principalId: member.id,
          level: "write",
          scopeType: "project",
          scope: project.id,
        }),
      );
    });
    await step("An Admin can't grant to themselves (403)", async () => {
      expectError(
        await adminApi.put("/grants", {
          principalType: "user",
          principalId: admin.id,
          level: "read",
          scopeType: "environment",
          scope: env.id,
        }),
        403,
        "SELF_GRANT",
      );
    });
  },
);
