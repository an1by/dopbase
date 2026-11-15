import { randomBytes } from "node:crypto";
import { cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import {
  agent,
  ALL_FEATURES,
  expectError,
  expectOk,
  freshSession,
  QUIET,
  withSeedServer,
} from "./support.ts";

// The minimal setup: people management, custom roles and SSO all off. The
// server starts from a data dir made with everything on, so there are
// people, a group and grants from before, which the flags must keep.
// Playwright loads spec files in more than one process, so the path is
// only named here; the copy in beforeAll creates it, and afterAll removes it.
const seedDir = join(
  tmpdir(),
  `dopbase-e2e-flags-${process.pid}-${randomBytes(4).toString("hex")}`,
);
const seeded = {
  person: {
    id: "",
    email: "kept@dopbase.com",
    password: "kept-person-password-1",
  },
  groupId: "",
  grantId: "",
  projectId: "",
  envId: "",
};

// Runs before useServer's own beforeAll, which copies the seeded data dir.
test.beforeAll(async ({}, info) => {
  info.setTimeout(60_000);
  await withSeedServer(
    ALL_FEATURES,
    async (call) => {
      const person = await call("POST", "/users", {
        email: seeded.person.email,
        password: seeded.person.password,
        roleId: "rol_member",
      });
      seeded.person.id = person.id;
      const project = await call("POST", "/projects", { name: "kept-project" });
      seeded.projectId = project.id;
      const env = await call("POST", "/projects/kept-project/environments", {
        name: "dev",
      });
      seeded.envId = env.id;
      const saved = await call("PUT", "/grants", {
        principalType: "user",
        principalId: person.id,
        level: "write",
        scopeType: "project",
        scope: project.id,
      });
      seeded.grantId = saved.id;
      const group = await call("POST", "/groups", { name: "Kept team" });
      seeded.groupId = group.group.id;
      await call("PUT", `/groups/${group.group.id}/members/${person.id}`);
    },
    (dataDir) => cp(dataDir, seedDir, { recursive: true }),
  );
});

const app = useServer({
  dataDir: seedDir,
  env: {
    DOPBASE_RBAC: "false",
    DOPBASE_RBAC_ROLES: "false",
    DOPBASE_SSO: "false",
  },
});

test.afterAll(async () => {
  await rm(seedDir, { recursive: true, force: true });
});

test(
  "with DOPBASE_RBAC off, people, roles, groups and grants stop changing",
  {
    tag: "@access",
    annotation: about(
      "Without RBAC no one adds people, roles or groups or changes a person's access (403 FEATURE_DISABLED), while what was there keeps working and AI agents still get access.",
    ),
  },
  async () => {
    const { person } = seeded;
    await step("GET /auth/session lists no features", async () => {
      expect(expectOk(await app.api.get("/auth/session")).features).toEqual([]);
    });
    await step("POST /users is 403 FEATURE_DISABLED", async () => {
      expectError(
        await app.api.post("/users", {
          email: `${app.uniq("p")}@dopbase.com`,
          password: "minimal-setup-123",
          roleId: "rol_member",
        }),
        403,
        "FEATURE_DISABLED",
      );
    });
    await step(
      "PATCH /users/{id} changing the role is 403 FEATURE_DISABLED",
      async () => {
        expectError(
          await app.api.patch(`/users/${person.id}`, { roleId: "rol_auditor" }),
          403,
          "FEATURE_DISABLED",
        );
      },
    );
    await step("Disable and enable still work", async () => {
      expectOk(await app.api.post(`/users/${person.id}/disable`));
      expectOk(await app.api.post(`/users/${person.id}/enable`));
    });
    await step("POST /roles is 403 FEATURE_DISABLED", async () => {
      expectError(
        await app.api.post("/roles", {
          name: app.uniq("Custom"),
          maxLevel: "read",
        }),
        403,
        "FEATURE_DISABLED",
      );
    });
    await step("GET /roles still lists the built-in roles", async () => {
      const names = expectOk(await app.api.get("/roles")).map(
        (r: { name: string }) => r.name,
      );
      expect(names).toEqual(
        expect.arrayContaining(["Admin", "Member", "Auditor", "AI agent"]),
      );
    });
    await step(
      "POST /groups and adding or removing a member are 403 FEATURE_DISABLED",
      async () => {
        expectError(
          await app.api.post("/groups", { name: app.uniq("Team") }),
          403,
          "FEATURE_DISABLED",
        );
        // Root isn't in the group, so this would add a second member.
        const { adminId } = expectOk(await app.api.get("/auth/session"));
        expectError(
          await app.api.put(`/groups/${seeded.groupId}/members/${adminId}`),
          403,
          "FEATURE_DISABLED",
        );
        expectError(
          await app.api.delete(
            `/groups/${seeded.groupId}/members/${person.id}`,
          ),
          403,
          "FEATURE_DISABLED",
        );
      },
    );
    await step("The existing group keeps its member", async () => {
      const groups = expectOk(await app.api.get("/groups"));
      const kept = groups.find((g: { id: string }) => g.id === seeded.groupId);
      expect(kept?.memberCount).toBe(1);
    });
    await step("PUT /grants for a person is 403 FEATURE_DISABLED", async () => {
      expectError(
        await app.api.put("/grants", {
          principalType: "user",
          principalId: person.id,
          level: "read",
          scopeType: "environment",
          scope: seeded.envId,
        }),
        403,
        "FEATURE_DISABLED",
      );
    });
    await step(
      "DELETE /grants/{id} of a person's grant is 403 FEATURE_DISABLED",
      async () => {
        expectError(
          await app.api.delete(`/grants/${seeded.grantId}`),
          403,
          "FEATURE_DISABLED",
        );
      },
    );
    await step(
      "The person still signs in and writes with their old grant",
      async () => {
        const session = await freshSession(app, person);
        expectOk(
          await session.send(
            "PUT",
            `/environments/${seeded.envId}/secrets/API_KEY`,
            { value: app.value() },
            QUIET,
          ),
        );
        await session.dispose();
      },
    );
    const bot = await agent(app);
    await step("An AI agent is still created and granted", async () => {
      const saved = expectOk(
        await app.api.put("/grants", {
          principalType: "agent",
          principalId: bot.id,
          level: "read",
          scopeType: "project",
          scope: seeded.projectId,
        }),
      );
      expect(saved.principalId).toBe(bot.id);
      expectOk(await app.api.delete(`/grants/${saved.id}`));
    });
  },
);

test(
  "with DOPBASE_SSO off, SSO routes are not offered",
  {
    tag: "@sso",
    annotation: about(
      "Without SSO the login page offers only the password, and the single sign-on routes answer 403 FEATURE_DISABLED.",
    ),
  },
  async () => {
    await step("GET /auth/methods offers no SSO", async () => {
      const methods = expectOk(
        await (await app.anonymousApi()).get("/auth/methods"),
      );
      expect(methods.sso).toBeNull();
      expect(methods.password).toBe(true);
    });
    await step("GET /sso/provider is 403 FEATURE_DISABLED", async () => {
      expectError(await app.api.get("/sso/provider"), 403, "FEATURE_DISABLED");
    });
    await step("PUT /sso/provider is 403 FEATURE_DISABLED", async () => {
      expectError(
        await app.api.put("/sso/provider", {
          preset: "generic",
          displayName: "Nope",
          issuer: "https://idp.dopbase.com",
          clientId: "x",
          clientSecret: "y",
        }),
        403,
        "FEATURE_DISABLED",
      );
    });
    await step("GET /auth/sso/start is 403 FEATURE_DISABLED", async () => {
      expectError(
        await (await app.anonymousApi()).get("/auth/sso/start"),
        403,
        "FEATURE_DISABLED",
      );
    });
    await step("POST /auth/sso/link is 403 FEATURE_DISABLED", async () => {
      expectError(
        await app.api.post("/auth/sso/link"),
        403,
        "FEATURE_DISABLED",
      );
    });
  },
);
