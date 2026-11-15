import { ApiClient } from "../harness/api.ts";
import { grant } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { expectError, expectOk, personalToken, QUIET } from "./support.ts";

const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "people: create, read, update, disable, enable and delete",
  {
    tag: "@people",
    annotation: about(
      "Root adds a Member, finds them in the list and by id, changes their role, disables and re-enables them, and deletes them.",
    ),
  },
  async () => {
    const email = `${app.uniq("ann")}@dopbase.com`;
    const user = await step(`POST /users ${email} as Member`, async () => {
      const created = expectOk(
        await app.api.post("/users", {
          email,
          password: "ann-password-123456",
          roleId: "rol_member",
        }),
        201,
      );
      expect(created).toMatchObject({
        email,
        roleId: "rol_member",
        roleName: "Member",
        status: "active",
        hasPassword: true,
      });
      return created;
    });
    await step("GET /users lists them", async () => {
      const list = expectOk(await app.api.get("/users"));
      expect(list.map((u: { id: string }) => u.id)).toContain(user.id);
    });
    await step("GET /users/{id}", async () => {
      expect(expectOk(await app.api.get(`/users/${user.id}`)).email).toBe(
        email,
      );
    });
    await step("PATCH /users/{id} makes them an Auditor", async () => {
      expect(
        expectOk(
          await app.api.patch(`/users/${user.id}`, { roleId: "rol_auditor" }),
        ).roleName,
      ).toBe("Auditor");
    });
    await step("POST /users/{id}/disable", async () => {
      expect(
        expectOk(await app.api.post(`/users/${user.id}/disable`)).status,
      ).toBe("disabled");
    });
    await step("POST /users/{id}/enable", async () => {
      expect(
        expectOk(await app.api.post(`/users/${user.id}/enable`)).status,
      ).toBe("active");
    });
    await step("DELETE /users/{id}", async () => {
      expectOk(await app.api.delete(`/users/${user.id}`));
    });
    await step("The deleted person is 404 and no longer listed", async () => {
      expectError(
        await app.api.get(`/users/${user.id}`),
        404,
        "USER_NOT_FOUND",
      );
      const list = expectOk(await app.api.get("/users"));
      expect(list.map((u: { id: string }) => u.id)).not.toContain(user.id);
    });
  },
);

test(
  "people validation and limits on who manages whom",
  {
    tag: "@people",
    annotation: about(
      "Duplicate emails are 409, bad emails and short passwords 422, unknown ids 404; root can't disable or delete itself, Members see an empty people list and can't add anyone, and an Admin can't touch root.",
    ),
  },
  async () => {
    const existing = await app.make.user();
    await step("POST /users with a taken email is 409", async () => {
      expectError(
        await app.api.post("/users", {
          email: existing.email,
          password: "another-password-123",
          roleId: "rol_member",
        }),
        409,
        "EMAIL_ALREADY_EXISTS",
      );
    });
    await step("POST /users with a bad email is 422", async () => {
      expectError(
        await app.api.post("/users", {
          email: "not-an-email",
          password: "another-password-123",
          roleId: "rol_member",
        }),
        422,
        "EMAIL_INVALID",
      );
    });
    await step("POST /users with a short password is 422", async () => {
      expectError(
        await app.api.post("/users", {
          email: `${app.uniq("short")}@dopbase.com`,
          password: "short",
          roleId: "rol_member",
        }),
        422,
        "PASSWORD_TOO_SHORT",
      );
    });
    await step("Unknown user ids are 404", async () => {
      expectError(
        await app.api.get("/users/usr_unknown"),
        404,
        "USER_NOT_FOUND",
      );
      expectError(
        await app.api.patch("/users/usr_unknown", { roleId: "rol_member" }),
        404,
        "USER_NOT_FOUND",
      );
      expectError(
        await app.api.post("/users/usr_unknown/disable"),
        404,
        "USER_NOT_FOUND",
      );
      expectError(
        await app.api.post("/users/usr_unknown/enable"),
        404,
        "USER_NOT_FOUND",
      );
      expectError(
        await app.api.delete("/users/usr_unknown"),
        404,
        "USER_NOT_FOUND",
      );
    });
    const root = expectOk(await app.api.get("/auth/session"));
    await step("Root can't disable or delete itself (403)", async () => {
      expectError(
        await app.api.post(`/users/${root.adminId}/disable`),
        403,
        "SELF_DISABLE_FORBIDDEN",
      );
      expectError(
        await app.api.delete(`/users/${root.adminId}`),
        403,
        "SELF_DELETE_FORBIDDEN",
      );
    });
    await step("People routes without a session are 401", async () => {
      const anonymous = await app.anonymousApi();
      expectError(await anonymous.get("/users"), 401);
      expectError(
        await anonymous.post("/users", {
          email: "x@dopbase.com",
          roleId: "rol_member",
        }),
        401,
      );
    });
    await step(
      "A Member sees nobody in GET /users and can't add people (403)",
      async () => {
        const api = await app.apiAs(existing);
        expect(expectOk(await api.get("/users"))).toEqual([]);
        expectError(
          await api.post("/users", {
            email: `${app.uniq("m")}@dopbase.com`,
            password: "member-made-password",
            roleId: "rol_member",
          }),
          403,
          "AUTHORIZATION_DENIED",
        );
      },
    );
    const admin = await app.make.user({ role: "Admin" });
    await step("An Admin can't disable root (403)", async () => {
      const api = await app.apiAs(admin);
      expect((await api.post(`/users/${root.adminId}/disable`)).status).toBe(
        403,
      );
      expect(expectOk(await app.api.get(`/users/${root.adminId}`)).status).toBe(
        "active",
      );
    });
  },
);

test(
  "a disabled person can't sign in and their sessions end",
  {
    tag: "@people",
    annotation: about(
      "Disabling a person ends their open session and personal tokens at once and refuses new logins; enabling lets them sign in again.",
    ),
  },
  async () => {
    const user = await app.make.user();
    const session = await app.apiAs(user);
    const token = await personalToken(app, { id: user.id }, { as: session });
    const tokenApi = await app.apiWithToken(token.token);
    await step("Before: the session and the token both work", async () => {
      expectOk(await session.get("/auth/session"));
      expectOk(await tokenApi.get("/projects"));
    });
    await step("POST /users/{id}/disable", async () => {
      expectOk(await app.api.post(`/users/${user.id}/disable`));
    });
    await step("The open session is 401", async () => {
      expectError(await session.get("/auth/session"), 401);
    });
    await step("The personal token is 401", async () => {
      expectError(await tokenApi.get("/projects"), 401);
    });
    const fresh = await ApiClient.create(app.url, "fresh", []);
    await step("POST /auth/login for the disabled person is 401", async () => {
      expect(
        (
          await fresh.post("/auth/login", {
            email: user.email,
            password: user.password,
            sessionKind: "browser",
          })
        ).status,
      ).toBe(401);
    });
    await step("POST /users/{id}/enable, then login works again", async () => {
      expectOk(await app.api.post(`/users/${user.id}/enable`));
      expectOk(
        await fresh.post("/auth/login", {
          email: user.email,
          password: user.password,
          sessionKind: "browser",
        }),
      );
    });
    await fresh.dispose();
    await tokenApi.dispose();
  },
);

test(
  "identities, per-person access and personal tokens",
  {
    tag: "@people",
    annotation: about(
      "GET /users/identities lists every email, GET /users/{id}/access shows a person's grants; a person makes their own personal tokens, and root lists and revokes them.",
    ),
  },
  async () => {
    const user = await app.make.user();
    const project = await app.make.project();
    await grant(app, user, "read", { project: project.id });
    await step("GET /users/identities includes the person", async () => {
      const identities = expectOk(await app.api.get("/users/identities"));
      expect(identities).toContainEqual({ id: user.id, email: user.email });
    });
    await step("GET /users/{id}/access shows the read grant", async () => {
      const access = expectOk(await app.api.get(`/users/${user.id}/access`));
      expect(access).toMatchObject({
        userId: user.id,
        roleName: "Member",
        maxLevel: "manage",
      });
      expect(access.grants).toEqual([
        expect.objectContaining({ scopeId: project.id, level: "read" }),
      ]);
    });
    await step("GET /users/{id}/access for an unknown id is 404", async () => {
      expect((await app.api.get("/users/usr_unknown/access")).status).toBe(404);
    });
    const own = await app.apiAs(user);
    await step("Root can't make a token for a person (403)", async () => {
      expectError(
        await app.api.post(`/users/${user.id}/tokens`, {
          name: "for-them",
          level: "read",
          expiresIn: "7d",
        }),
        403,
        "TOKEN_OWNER_INVALID",
      );
    });
    const created = await step(
      "POST /users/{id}/tokens laptop (read, 7 days) as the person",
      async () => {
        const result = expectOk(
          await own.post(`/users/${user.id}/tokens`, {
            name: "laptop",
            level: "read",
            scopeType: "project",
            scope: project.id,
            expiresIn: "7d",
          }),
          201,
        );
        expect(result.plaintextToken).toMatch(/^dpp_/);
        expect(result.token).toMatchObject({
          userId: user.id,
          level: "read",
          scopeType: "project",
        });
        return result;
      },
    );
    await step("A token above the role's token level is 422", async () => {
      expectError(
        await own.post(`/users/${user.id}/tokens`, {
          name: "too-much",
          level: "manage",
          expiresIn: "7d",
        }),
        422,
        "TOKEN_LEVEL_INVALID",
      );
    });
    await step(
      "GET /users/{id}/tokens lists it without the secret",
      async () => {
        const list = expectOk(await app.api.get(`/users/${user.id}/tokens`));
        expect(list.map((t: { id: string }) => t.id)).toEqual([
          created.token.id,
        ]);
        expect(JSON.stringify(list)).not.toContain(created.plaintextToken);
      },
    );
    await step("The token reads the project", async () => {
      const api = await app.apiWithToken(created.plaintextToken);
      expect(
        (await api.send("GET", `/projects/${project.id}`, undefined, QUIET))
          .status,
      ).toBe(200);
      await api.dispose();
    });
    await step("POST /users/{id}/tokens/{tokenId}/revoke", async () => {
      expectOk(
        await app.api.post(
          `/users/${user.id}/tokens/${created.token.id}/revoke`,
        ),
      );
    });
    await step(
      "The revoked token is 401 and a second revoke is 409",
      async () => {
        const api = await app.apiWithToken(created.plaintextToken);
        expectError(await api.get("/projects"), 401);
        await api.dispose();
        expect(
          (
            await app.api.post(
              `/users/${user.id}/tokens/${created.token.id}/revoke`,
            )
          ).status,
        ).toBe(409);
      },
    );
    await step("Revoking an unknown token is 404", async () => {
      expect(
        (await app.api.post(`/users/${user.id}/tokens/ptk_unknown/revoke`))
          .status,
      ).toBe(404);
    });
    await step(
      "Another Member can't see this person's tokens (403)",
      async () => {
        const other = await app.apiAs(await app.make.user());
        expect((await other.get(`/users/${user.id}/tokens`)).status).toBe(403);
      },
    );
  },
);
