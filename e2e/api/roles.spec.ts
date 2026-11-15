import { about, expect, step, test, useServer } from "../harness/index.ts";
import {
  ALL_FEATURES,
  expectError,
  expectOk,
  QUIET,
  userWithRole,
} from "./support.ts";

const app = useServer({ env: ALL_FEATURES });

test(
  "custom role create, update and delete",
  {
    tag: "@access",
    annotation: about(
      "Root creates a custom role with chosen capabilities and ceiling, edits it, can't delete it while someone holds it, and deletes it once nobody does.",
    ),
  },
  async () => {
    const name = app.uniq("Release manager");
    const role = await step(`POST /roles ${name}`, async () => {
      const created = expectOk(
        await app.api.post("/roles", {
          name,
          description: "Ships releases.",
          maxLevel: "write",
          capabilities: ["audit.read", "tokens.personal"],
        }),
        201,
      );
      expect(created).toMatchObject({
        name,
        builtin: false,
        maxLevel: "write",
        members: 0,
      });
      expect([...created.capabilities].sort()).toEqual([
        "audit.read",
        "tokens.personal",
      ]);
      return created;
    });
    await step(
      "GET /roles lists the four built-in roles and the new one",
      async () => {
        const names = expectOk(await app.api.get("/roles")).map(
          (r: { name: string }) => r.name,
        );
        expect(names).toEqual(
          expect.arrayContaining([
            "Admin",
            "Member",
            "Auditor",
            "AI agent",
            name,
          ]),
        );
      },
    );
    await step(
      "PATCH /roles/{id} raises the ceiling and adds users.view",
      async () => {
        const updated = expectOk(
          await app.api.patch(`/roles/${role.id}`, {
            maxLevel: "manage",
            capabilities: ["audit.read", "tokens.personal", "users.view"],
          }),
        );
        expect(updated.maxLevel).toBe("manage");
        expect(updated.capabilities).toContain("users.view");
      },
    );
    const holder = await userWithRole(app, role.id);
    await step("A person holding it gets its capabilities", async () => {
      const session = expectOk(
        await (await app.apiAs(holder)).get("/auth/session"),
      );
      expect(session.roleName).toBe(name);
      expect(session.capabilities).toContain("users.view");
      expect(session.maxLevel).toBe("manage");
    });
    await step("DELETE /roles/{id} while someone holds it is 409", async () => {
      expectError(
        await app.api.delete(`/roles/${role.id}`),
        409,
        "ROLE_IN_USE",
      );
    });
    await app.api.must("DELETE", `/users/${holder.id}`, undefined, QUIET);
    await step("DELETE /roles/{id} once nobody holds it", async () => {
      expectOk(await app.api.delete(`/roles/${role.id}`));
      const ids = expectOk(await app.api.get("/roles")).map(
        (r: { id: string }) => r.id,
      );
      expect(ids).not.toContain(role.id);
    });
    await step("PATCH and DELETE an unknown role are 404", async () => {
      expectError(
        await app.api.patch(`/roles/${role.id}`, { name: "Gone" }),
        404,
        "ROLE_NOT_FOUND",
      );
      expectError(
        await app.api.delete(`/roles/${role.id}`),
        404,
        "ROLE_NOT_FOUND",
      );
    });
  },
);

test(
  "built-in roles can't be changed or deleted",
  {
    tag: "@access",
    annotation: about(
      "Admin, Member, Auditor and AI agent are fixed: PATCH and DELETE on them are 403 ROLE_BUILTIN.",
    ),
  },
  async () => {
    for (const id of [
      "rol_admin",
      "rol_member",
      "rol_auditor",
      "rol_ai_agent",
    ]) {
      await step(`DELETE /roles/${id} is 403`, async () => {
        expectError(await app.api.delete(`/roles/${id}`), 403, "ROLE_BUILTIN");
      });
    }
    await step("PATCH /roles/rol_member is 403", async () => {
      expectError(
        await app.api.patch("/roles/rol_member", {
          maxLevel: "project_manager",
        }),
        403,
        "ROLE_BUILTIN",
      );
    });
    await step("Member is unchanged", async () => {
      const member = expectOk(await app.api.get("/roles")).find(
        (r: { id: string }) => r.id === "rol_member",
      );
      expect(member.maxLevel).toBe("manage");
    });
  },
);

test(
  "root-only capabilities can't be put on a role",
  {
    tag: "@access",
    annotation: about(
      "Capabilities such as roles.manage, sso.manage and instance.reset belong to root alone; asking for them on a role is 422, and so are bad names, levels and duplicates.",
    ),
  },
  async () => {
    for (const capability of [
      "roles.manage",
      "grants.all_projects",
      "sso.manage",
      "instance.backup",
      "instance.reset",
      "password.breakglass",
    ]) {
      await step(`POST /roles with ${capability} is 422`, async () => {
        expectError(
          await app.api.post("/roles", {
            name: app.uniq("Greedy"),
            maxLevel: "read",
            capabilities: [capability],
          }),
          422,
          "ROLE_CAPABILITY_INVALID",
        );
      });
    }
    const role = await app.api.must(
      "POST",
      "/roles",
      { name: app.uniq("Plain"), maxLevel: "read", capabilities: [] },
      QUIET,
    );
    await step("PATCH /roles/{id} adding sso.manage is 422", async () => {
      expectError(
        await app.api.patch(`/roles/${role.id}`, {
          capabilities: ["sso.manage"],
        }),
        422,
        "ROLE_CAPABILITY_INVALID",
      );
    });
    await step(
      "POST /roles with the name of an existing role is 409",
      async () => {
        expectError(
          await app.api.post("/roles", { name: role.name, maxLevel: "read" }),
          409,
          "ROLE_ALREADY_EXISTS",
        );
      },
    );
    await step("POST /roles with an empty name is 422", async () => {
      expectError(
        await app.api.post("/roles", { name: "", maxLevel: "read" }),
        422,
        "ROLE_NAME_INVALID",
      );
    });
    await step("Role routes without a session are 401", async () => {
      const anonymous = await app.anonymousApi();
      expectError(await anonymous.get("/roles"), 401);
      expectError(
        await anonymous.post("/roles", { name: "x", maxLevel: "read" }),
        401,
      );
    });
    await step("An Admin can't create roles (403)", async () => {
      const admin = await app.apiAs(await app.make.user({ role: "Admin" }));
      expectError(
        await admin.post("/roles", {
          name: app.uniq("Admin made"),
          maxLevel: "read",
        }),
        403,
        "AUTHORIZATION_DENIED",
      );
    });
  },
);
