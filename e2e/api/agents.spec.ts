import { ApiClient } from "../harness/api.ts";
import { grant } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import {
  agent,
  expectError,
  expectOk,
  personalToken,
  QUIET,
} from "./support.ts";

const app = useServer({ env: { DOPBASE_RBAC: "true" } });

test(
  "an AI agent is created with a person as owner",
  {
    tag: "@people",
    annotation: about(
      "A Member creates an agent and owns it; root sees it, moves it to another person, which revokes the tokens made under the old owner, and can't make another agent or an unknown id its owner.",
    ),
  },
  async () => {
    const member = await app.make.user();
    const api = await app.apiAs(member);
    const name = app.uniq("deploy-bot");
    const bot = await step(`POST /agents ${name} as a Member`, async () => {
      const created = expectOk(await api.post("/agents", { name }), 201);
      expect(created).toMatchObject({
        name,
        roleName: "AI agent",
        ownerId: member.id,
        ownerEmail: member.email,
        status: "active",
      });
      return created;
    });
    await step("POST /agents with ownerId set is 400", async () => {
      expectError(
        await app.api.post("/agents", {
          name: app.uniq("bot"),
          ownerId: member.id,
        }),
        400,
        "OWNER_NOT_SETTABLE",
      );
    });
    await step("POST /agents with a taken name is 409", async () => {
      expect((await app.api.post("/agents", { name })).status).toBe(409);
    });
    await step("POST /agents with an invalid name is 422", async () => {
      expect(
        (await app.api.post("/agents", { name: "Not Valid!" })).status,
      ).toBe(422);
    });
    await step("GET /agents lists it for root and its owner", async () => {
      for (const client of [app.api, api]) {
        const list = expectOk(await client.get("/agents"));
        expect(list.map((a: { id: string }) => a.id)).toContain(bot.id);
      }
    });
    await step("GET /agents/{id}", async () => {
      expect(expectOk(await app.api.get(`/agents/${bot.id}`)).ownerId).toBe(
        member.id,
      );
    });
    const other = await app.make.user();
    const beforeMove = await personalToken(
      app,
      { id: bot.id, kind: "agents" },
      { as: api, level: "metadata" },
    );
    const botApi = await app.apiWithToken(beforeMove.token);
    await step("The owner's token for the agent works", async () => {
      expectOk(await botApi.get("/projects"));
    });
    await step("PATCH /agents/{id} moves it to another person", async () => {
      expect(
        expectOk(
          await app.api.patch(`/agents/${bot.id}`, { ownerId: other.id }),
        ),
      ).toMatchObject({ ownerId: other.id, ownerEmail: other.email });
    });
    await step("Moving the owner revoked the agent's token (401)", async () => {
      expectError(await botApi.get("/projects"), 401);
    });
    await botApi.dispose();
    const second = await agent(app);
    await step("Another agent can't own it (refused)", async () => {
      const result = await app.api.patch(`/agents/${bot.id}`, {
        ownerId: second.id,
      });
      expectError(result, 400, "OWNER_INVALID");
      expect(expectOk(await app.api.get(`/agents/${bot.id}`)).ownerId).toBe(
        other.id,
      );
    });
    await step("PATCH /agents/{id} renames it", async () => {
      const renamed = app.uniq("renamed-bot");
      expect(
        expectOk(await app.api.patch(`/agents/${bot.id}`, { name: renamed }))
          .name,
      ).toBe(renamed);
    });
    await step("DELETE /agents/{id}, then it is 404", async () => {
      expectOk(await app.api.delete(`/agents/${bot.id}`));
      expect((await app.api.get(`/agents/${bot.id}`)).status).toBe(404);
    });
    await step("Agent routes without a session are 401", async () => {
      const anonymous = await app.anonymousApi();
      expectError(await anonymous.get("/agents"), 401);
      expectError(await anonymous.post("/agents", { name: "x" }), 401);
    });
  },
);

test(
  "an AI agent signs in with tokens only",
  {
    tag: "@people",
    annotation: about(
      "An agent has no password: password login with its name is refused, while a personal token its owner makes for it works and lists in GET /agents/{id}/tokens.",
    ),
  },
  async () => {
    const owner = await app.make.user();
    const ownerApi = await app.apiAs(owner);
    const bot = await agent(app, { as: ownerApi });
    const env = await app.make.environment();
    const value = await app.make.secret(env, "API_KEY");
    await grant(app, owner, "read", { project: env.projectId });
    await grant(app, { type: "agent", id: bot.id }, "read", {
      project: env.projectId,
    });
    await step(
      "POST /auth/login with the agent's name is refused (422, not an email)",
      async () => {
        const fresh = await ApiClient.create(app.url, "fresh", []);
        expect(
          (
            await fresh.post("/auth/login", {
              email: bot.name,
              password: "anything-at-all-123",
              sessionKind: "browser",
            })
          ).status,
        ).toBe(422);
        await fresh.dispose();
      },
    );
    await step("Giving the AI agent role a password is refused", async () => {
      expect(
        (
          await app.api.send(
            "POST",
            "/users",
            {
              email: app.uniq("pw-bot"),
              password: "agents-have-none",
              roleId: "rol_ai_agent",
            },
            QUIET,
          )
        ).status,
      ).toBe(400);
    });
    const created = await step(
      "POST /agents/{id}/tokens as the owner",
      async () => {
        const result = expectOk(
          await ownerApi.post(`/agents/${bot.id}/tokens`, {
            name: "ci",
            level: "read",
            scopeType: "all",
            expiresIn: "7d",
          }),
          201,
        );
        expect(result.plaintextToken).toMatch(/^dpp_/);
        expect(result.token.userId).toBe(bot.id);
        return result;
      },
    );
    await step(
      "The agent's token reveals the secret it was granted",
      async () => {
        const api = await app.apiWithToken(created.plaintextToken);
        expect(
          expectOk(
            await api.post(`/environments/${env.id}/secrets/API_KEY/reveal`),
          ).value,
        ).toBe(value);
        await api.dispose();
      },
    );
    await step("GET /agents/{id}/tokens lists the token", async () => {
      const list = expectOk(await ownerApi.get(`/agents/${bot.id}/tokens`));
      expect(list.map((t: { id: string }) => t.id)).toEqual([created.token.id]);
    });
    await step(
      "GET /agents/{id}/access shows the agent's grant and owner",
      async () => {
        const access = expectOk(await app.api.get(`/agents/${bot.id}/access`));
        expect(access).toMatchObject({
          userId: bot.id,
          ownerEmail: owner.email,
        });
        expect(access.grants).toEqual([
          expect.objectContaining({ scopeId: env.projectId, level: "read" }),
        ]);
      },
    );
    await step(
      "Another Member can't make tokens for this agent (403)",
      async () => {
        const stranger = await app.apiAs(await app.make.user());
        expect(
          (
            await stranger.post(`/agents/${bot.id}/tokens`, {
              name: "theirs",
              level: "read",
              expiresIn: "7d",
            })
          ).status,
        ).toBe(403);
      },
    );
  },
);

test(
  "an AI agent never reaches more than its owner",
  {
    tag: "@people",
    annotation: about(
      "Root grants an agent write, but its owner only has read: the agent's token can read and not write until the owner gets write too.",
    ),
  },
  async () => {
    const owner = await app.make.user();
    const ownerApi = await app.apiAs(owner);
    const bot = await agent(app, { as: ownerApi });
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    await grant(app, owner, "read", { project: env.projectId });
    await grant(app, { type: "agent", id: bot.id }, "write", {
      project: env.projectId,
    });
    const token = await personalToken(
      app,
      { id: bot.id, kind: "agents" },
      { as: ownerApi, level: "write" },
    );
    const api = await app.apiWithToken(token.token);
    await step("The agent's token reads the value", async () => {
      expectOk(
        await api.post(`/environments/${env.id}/secrets/API_KEY/reveal`),
      );
    });
    await step("Writing is 403 while the owner only has read", async () => {
      expectError(
        await api.put(`/environments/${env.id}/secrets/API_KEY`, {
          value: app.value(),
        }),
        403,
        "AUTHORIZATION_DENIED",
      );
    });
    await step(
      "The owner can't give their agent more than they have",
      async () => {
        const result = await ownerApi.send(
          "PUT",
          "/grants",
          {
            principalType: "agent",
            principalId: bot.id,
            scopeType: "project",
            scope: env.projectId,
            level: "manage",
          },
          QUIET,
        );
        expect(result.status).toBe(403);
      },
    );
    await grant(app, owner, "write", { project: env.projectId });
    await step(
      "Once the owner has write, the agent's token writes",
      async () => {
        expectOk(
          await api.put(`/environments/${env.id}/secrets/API_KEY`, {
            value: app.value(),
          }),
        );
      },
    );
    await step(
      "Disabling the owner stops the agent's token (401)",
      async () => {
        await app.api.must("POST", `/users/${owner.id}/disable`, {}, QUIET);
        expect(
          (await api.post(`/environments/${env.id}/secrets/API_KEY/reveal`))
            .status,
        ).toBe(401);
      },
    );
    await api.dispose();
  },
);

test(
  "disable and enable an agent, and revoke its token",
  {
    tag: "@people",
    annotation: about(
      "A disabled agent's tokens stop working until it is enabled again; a revoked token stays dead.",
    ),
  },
  async () => {
    const bot = await agent(app);
    const env = await app.make.environment();
    await grant(app, { type: "agent", id: bot.id }, "read", {
      project: env.projectId,
    });
    const token = await personalToken(app, { id: bot.id, kind: "agents" });
    const api = await app.apiWithToken(token.token);
    await step("The token lists projects", async () => {
      expectOk(await api.get("/projects"));
    });
    await step("POST /agents/{id}/disable", async () => {
      expect(
        expectOk(await app.api.post(`/agents/${bot.id}/disable`)).status,
      ).toBe("disabled");
    });
    await step("The disabled agent's token is 401", async () => {
      expectError(await api.get("/projects"), 401);
    });
    await step(
      "POST /agents/{id}/enable, and the token works again",
      async () => {
        expect(
          expectOk(await app.api.post(`/agents/${bot.id}/enable`)).status,
        ).toBe("active");
        expectOk(await api.get("/projects"));
      },
    );
    await step("POST /agents/{id}/tokens/{tokenId}/revoke", async () => {
      expectOk(
        await app.api.post(`/agents/${bot.id}/tokens/${token.id}/revoke`),
      );
    });
    await step(
      "The revoked token is 401, and revoking twice is 409",
      async () => {
        expectError(await api.get("/projects"), 401);
        expect(
          (await app.api.post(`/agents/${bot.id}/tokens/${token.id}/revoke`))
            .status,
        ).toBe(409);
      },
    );
    await step("Agent routes on an unknown id are 404", async () => {
      for (const result of [
        await app.api.get("/agents/agt_unknown"),
        await app.api.post("/agents/agt_unknown/disable"),
        await app.api.get("/agents/agt_unknown/tokens"),
      ]) {
        expect(result.status).toBe(404);
      }
    });
    await api.dispose();
  },
);

test(
  "a new agent token can replace the old ones",
  {
    tag: "@people",
    annotation: about(
      "POST /agents/{id}/tokens with replaceExisting revokes the agent's other live tokens in the same step; a person's own tokens can't be replaced that way (TOKEN_REPLACE_INVALID).",
    ),
  },
  async () => {
    const bot = await agent(app);
    const first = await personalToken(
      app,
      { id: bot.id, kind: "agents" },
      { level: "metadata" },
    );
    const firstApi = await app.apiWithToken(first.token);
    await step("The first token works", async () => {
      expectOk(await firstApi.get("/projects"));
    });
    const second = await step(
      "POST /agents/{id}/tokens with replaceExisting",
      async () =>
        expectOk(
          await app.api.post(`/agents/${bot.id}/tokens`, {
            name: app.uniq("tok"),
            level: "metadata",
            scopeType: "all",
            expiresIn: "7d",
            replaceExisting: true,
          }),
          201,
        ),
    );
    await step("The new token works and the first is 401", async () => {
      const secondApi = await app.apiWithToken(second.plaintextToken);
      expectOk(await secondApi.get("/projects"));
      await secondApi.dispose();
      expectError(await firstApi.get("/projects"), 401);
    });
    await step(
      "replaceExisting on a person's token is TOKEN_REPLACE_INVALID",
      async () => {
        const person = await app.make.user();
        const own = await app.apiAs(person);
        const result = await own.post(`/users/${person.id}/tokens`, {
          name: app.uniq("tok"),
          level: "metadata",
          scopeType: "all",
          expiresIn: "7d",
          replaceExisting: true,
        });
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(Object.keys(result.body?.error ?? {})).toContain(
          "TOKEN_REPLACE_INVALID",
        );
      },
    );
    await firstApi.dispose();
  },
);
