// Who can do what, table-driven. The expected outcomes live in
// access-matrix.table.ts; each test runs every cell, attaches the grid for
// the HTML report, and only then fails, listing every cell that differed.
import type { ApiClient } from "../harness/api.ts";
import { grant } from "../harness/helpers.ts";
import {
  about,
  expect,
  step,
  test,
  useServer,
  type Environment,
  type Project,
} from "../harness/index.ts";
import {
  ACTION_HELP,
  ACTIONS,
  CEILING,
  COMBINED,
  CUSTOM_ROLE,
  EXPECTED,
  LEVELS,
  PROTECTED,
  SUBJECTS,
  TOKENS,
  type Action,
  type Level,
  type Outcome,
  type Subject,
} from "./access-matrix.table.ts";
import {
  agent,
  ALL_FEATURES,
  customRole,
  expectOk,
  personalToken,
  QUIET,
  userWithRole,
} from "./support.ts";

const app = useServer({ env: ALL_FEATURES });

const ORDER: Record<Level, number> = Object.fromEntries(
  LEVELS.map((level, i) => [level, i]),
) as Record<Level, number>;

type Target = { project: Project; env: Environment };
type Cell = { expected: Outcome; actual: Outcome };
type GridRow = { label: string; cells: Cell[] };

/** A project with one environment (optionally protected) holding API_KEY. */
async function target(opts: { protected?: boolean } = {}): Promise<Target> {
  const project = await app.make.project();
  const env = await app.make.environment({
    project,
    name: "prod",
    protected: opts.protected ?? false,
  });
  await app.make.secret(env, "API_KEY");
  return { project, env };
}

/** Tries one action and says whether the server let it through. */
async function attempt(
  api: ApiClient,
  { project, env }: Target,
  action: Action,
): Promise<{ outcome: Outcome; status: number }> {
  let result;
  switch (action) {
    case "list":
      result = await api.get(`/environments/${env.id}/secrets`);
      break;
    case "read value":
      result = await api.post(`/environments/${env.id}/secrets/API_KEY/reveal`);
      break;
    case "write":
      result = await api.put(`/environments/${env.id}/secrets/API_KEY`, {
        value: app.value(),
      });
      break;
    case "manage env":
      // Renaming to its own name still needs manage, and changes nothing.
      result = await api.patch(`/environments/${env.id}`, { name: env.name });
      break;
    case "create token":
      result = await api.post(`/environments/${env.id}/tokens`, {
        name: app.uniq("matrix"),
        role: "runner",
      });
      break;
    case "read audit": {
      result = await api.get(
        `/audit-events?projectId=${project.id}&action=project.created`,
      );
      const seen =
        result.ok &&
        result.data.items.some(
          (e: { projectId: string }) => e.projectId === project.id,
        );
      return { outcome: seen ? "allow" : "deny", status: result.status };
    }
  }
  return { outcome: result.ok ? "allow" : "deny", status: result.status };
}

/**
 * Runs every row, never stopping at a failure, then attaches the grid and
 * fails with the list of cells that differed from the table.
 */
async function runGrid(
  columns: readonly string[],
  rows: {
    label: string;
    expected: readonly Outcome[];
    run: () => Promise<{ outcome: Outcome; status: number }[]>;
  }[],
): Promise<void> {
  const grid: GridRow[] = [];
  const problems: string[] = [];
  for (const row of rows) {
    let actual: { outcome: Outcome; status: number }[];
    try {
      actual = await step(row.label, row.run);
    } catch (error) {
      problems.push(
        `${row.label}: setup failed: ${String(error).split("\n")[0]}`,
      );
      actual = row.expected.map(() => ({ outcome: "deny", status: 0 }));
    }
    grid.push({
      label: row.label,
      cells: row.expected.map((expected, i) => ({
        expected,
        actual: actual[i]!.outcome,
      })),
    });
    row.expected.forEach((expected, i) => {
      const { outcome, status } = actual[i]!;
      if (outcome !== expected) {
        problems.push(
          `${row.label} × ${columns[i]}: expected ${expected}, got ${outcome} (HTTP ${status})`,
        );
      } else if (outcome === "deny") {
        // A deny must be a refusal, not a crash or a validation error. The
        // audit log may also answer 200 and leave out what the reader
        // can't see.
        const refusals = columns[i]!.startsWith("read audit")
          ? [200, 401, 403, 404, 0]
          : [401, 403, 404, 0];
        if (!refusals.includes(status)) {
          problems.push(
            `${row.label} × ${columns[i]}: denied with HTTP ${status}, expected ${refusals.filter(Boolean).join(", ")}`,
          );
        }
      }
    });
  }
  await test.info().attach("access-matrix.json", {
    body: JSON.stringify({ columns, rows: grid }),
    contentType: "application/json",
  });
  expect(
    problems,
    `cells that differ from the table:\n${problems.join("\n")}`,
  ).toEqual([]);
}

/** Gives `principal` `level` on the project: directly, or via a group above the ceiling. */
async function giveLevel(
  principal: { type: "user" | "agent"; id: string },
  level: Level,
  ceiling: Level,
  scope: { project: string } | { environment: string },
): Promise<string> {
  if (level === "none") return "no grant";
  if (ORDER[level] <= ORDER[ceiling]) {
    await grant(app, principal, level, scope);
    return "direct";
  }
  const group = (
    await app.api.must("POST", "/groups", { name: app.uniq("matrix") }, QUIET)
  ).group;
  await grant(app, { type: "group", id: group.id }, level, scope);
  await app.api.must(
    "PUT",
    `/groups/${group.id}/members/${principal.id}`,
    undefined,
    QUIET,
  );
  return "via a group, above the ceiling";
}

/** Removes the all-projects grant root gives every Admin it creates. */
async function dropStartingGrant(userId: string): Promise<void> {
  const access = await app.api.must(
    "GET",
    `/users/${userId}/access`,
    undefined,
    QUIET,
  );
  for (const g of access.grants) {
    if (g.scopeType === "all") {
      await app.api.must("DELETE", `/grants/${g.id}`, undefined, QUIET);
    }
  }
}

test(
  "built-in and custom roles at every level",
  {
    tag: "@access",
    annotation: about(
      "Each built-in role and a custom role (ceiling read, audit.read) gets each level on a project, then tries to list, reveal, write, manage the environment, make a runner token and read the project's audit events; the outcomes must match access-matrix.table.ts.",
    ),
  },
  async () => {
    test.setTimeout(180_000);
    const custom = await customRole(app, {
      maxLevel: CUSTOM_ROLE.maxLevel,
      capabilities: CUSTOM_ROLE.capabilities,
    });
    const roleIds: Record<Subject, string> = {
      Admin: "rol_admin",
      Member: "rol_member",
      Auditor: "rol_auditor",
      "AI agent": "rol_ai_agent",
      Custom: custom.id,
    };
    const rows = SUBJECTS.flatMap((subject) =>
      LEVELS.map((level) => ({
        label: `${subject} · ${level}`,
        expected: EXPECTED[subject][level],
        run: async () => {
          const where = await target();
          let api: ApiClient;
          if (subject === "AI agent") {
            const bot = await agent(app);
            await giveLevel(
              { type: "agent", id: bot.id },
              level,
              CEILING[subject],
              {
                project: where.project.id,
              },
            );
            const token = await personalToken(
              app,
              { id: bot.id, kind: "agents" },
              { level: "write" },
            );
            api = await app.apiWithToken(token.token);
          } else {
            const user = await userWithRole(app, roleIds[subject]);
            // Root gives a new Admin project manager on all projects. Drop
            // it, so the row shows what the project grant alone does.
            await dropStartingGrant(user.id);
            await giveLevel(
              { type: "user", id: user.id },
              level,
              CEILING[subject],
              {
                project: where.project.id,
              },
            );
            api = await app.apiAs(user);
          }
          const results = [];
          for (const action of ACTIONS)
            results.push(await attempt(api, where, action));
          return results;
        },
      })),
    );
    await runGrid(
      ACTIONS.map((a) => `${a} (${ACTION_HELP[a]})`),
      rows,
    );
  },
);

test(
  "protected environments need project manager or an environment grant",
  {
    tag: "@access",
    annotation: about(
      "On a protected environment an Admin's project grant below project manager reaches nothing, project manager reaches it as manage, and an environment grant reaches it at its own level.",
    ),
  },
  async () => {
    test.setTimeout(90_000);
    const rows = Object.entries(PROTECTED).map(([label, expected]) => ({
      label,
      expected,
      run: async () => {
        const where = await target({ protected: true });
        const [kind, level] = label.split(" · ") as [string, Level];
        const user = await app.make.user({ role: "Admin" });
        await dropStartingGrant(user.id);
        await grant(
          app,
          user,
          level,
          kind.startsWith("project")
            ? { project: where.project.id }
            : { environment: where.env.id },
        );
        const api = await app.apiAs(user);
        const results = [];
        for (const action of ACTIONS)
          results.push(await attempt(api, where, action));
        return results;
      },
    }));
    await runGrid(ACTIONS, rows);
  },
);

test(
  "group grants and direct grants combine as documented",
  {
    tag: "@access",
    annotation: about(
      "For a Member, a group grant and a direct grant on the same scope combine upward, while a grant on a more specific scope wins even when it is lower.",
    ),
  },
  async () => {
    test.setTimeout(90_000);
    const columns = ACTIONS.slice(0, 4);
    const newGroup = async () =>
      (
        await app.api.must(
          "POST",
          "/groups",
          { name: app.uniq("combo") },
          QUIET,
        )
      ).group.id as string;
    const join = (groupId: string, userId: string) =>
      app.api.must(
        "PUT",
        `/groups/${groupId}/members/${userId}`,
        undefined,
        QUIET,
      );
    const setups: Record<
      string,
      (user: { id: string }, where: Target) => Promise<void>
    > = {
      "group project read + direct project write": async (user, where) => {
        const g = await newGroup();
        await grant(app, { type: "group", id: g }, "read", {
          project: where.project.id,
        });
        await join(g, user.id);
        await grant(app, user, "write", { project: where.project.id });
      },
      "group project manage + direct project read": async (user, where) => {
        const g = await newGroup();
        await grant(app, { type: "group", id: g }, "manage", {
          project: where.project.id,
        });
        await join(g, user.id);
        await grant(app, user, "read", { project: where.project.id });
      },
      "group project manage + direct environment read": async (user, where) => {
        const g = await newGroup();
        await grant(app, { type: "group", id: g }, "manage", {
          project: where.project.id,
        });
        await join(g, user.id);
        await grant(app, user, "read", { environment: where.env.id });
      },
      "direct project manage + group environment metadata": async (
        user,
        where,
      ) => {
        const g = await newGroup();
        await grant(app, { type: "group", id: g }, "metadata", {
          environment: where.env.id,
        });
        await join(g, user.id);
        await grant(app, user, "manage", { project: where.project.id });
      },
      "group all-projects write + nothing else": async (user) => {
        const g = await newGroup();
        await grant(app, { type: "group", id: g }, "write", { all: true });
        await join(g, user.id);
      },
      "two groups: project read and project write": async (user, where) => {
        const [g1, g2] = [await newGroup(), await newGroup()];
        await grant(app, { type: "group", id: g1 }, "read", {
          project: where.project.id,
        });
        await grant(app, { type: "group", id: g2 }, "write", {
          project: where.project.id,
        });
        await join(g1, user.id);
        await join(g2, user.id);
      },
    };
    const rows = Object.entries(COMBINED).map(([label, expected]) => ({
      label,
      expected,
      run: async () => {
        const where = await target();
        const user = await app.make.user();
        await setups[label]!(user, where);
        const api = await app.apiAs(user);
        const results = [];
        for (const action of columns)
          results.push(await attempt(api, where, action));
        return results;
      },
    }));
    await runGrid(columns, rows);
  },
);

/** A second project the owner reads, for a token scoped away from the target. */
async function otherProject(owner: { id: string }): Promise<string> {
  const project = await app.make.project();
  await grant(app, owner, "read", { project: project.id });
  return project.id;
}

test(
  "personal and agent tokens never exceed their owner",
  {
    tag: "@access",
    annotation: about(
      "A personal token reaches the lower of its owner's access and its own scope and level; an AI agent's token is also held to its owner's access.",
    ),
  },
  async () => {
    test.setTimeout(90_000);
    const columns = ACTIONS.slice(0, 3);
    const rows = Object.entries(TOKENS).map(([label, expected]) => ({
      label,
      expected,
      run: async () => {
        const where = await target();
        const owner = await app.make.user();
        const ownerApi = await app.apiAs(owner);
        const parts = Object.fromEntries(
          label.split(" · ").map((part) => {
            const [who, ...rest] = part.split(" ");
            return [who, rest.join(" ")];
          }),
        ) as Record<string, string>;
        const ownerLevel = parts.owner as Level;
        if (ownerLevel !== "none") {
          await grant(app, owner, ownerLevel, { project: where.project.id });
        }
        const [tokenLevel, ...scopeWords] = parts.token!.split(", ");
        const scopeText = scopeWords.join(", ");
        const scope =
          scopeText === "other project only"
            ? {
                scopeType: "project" as const,
                scope: await otherProject(owner),
              }
            : scopeText === "this environment"
              ? { scopeType: "environment" as const, scope: where.env.id }
              : { scopeType: "all" as const };
        let token;
        if (parts.agent) {
          const bot = await agent(app, { as: ownerApi });
          await grant(
            app,
            { type: "agent", id: bot.id },
            parts.agent as Level,
            {
              project: where.project.id,
            },
          );
          token = await personalToken(
            app,
            { id: bot.id, kind: "agents" },
            { as: ownerApi, level: tokenLevel as Level, ...scope },
          );
        } else {
          token = await personalToken(
            app,
            { id: owner.id },
            { as: ownerApi, level: tokenLevel as Level, ...scope },
          );
        }
        const api = await app.apiWithToken(token.token);
        const results = [];
        for (const action of columns)
          results.push(await attempt(api, where, action));
        await api.dispose();
        return results;
      },
    }));
    await runGrid(columns, rows);
  },
);

test(
  "root holds every capability",
  {
    tag: "@access",
    annotation: about(
      "Root's session lists all 21 capabilities, and root does every matrix action on a protected environment without any grant.",
    ),
  },
  async () => {
    await step("GET /auth/session lists every capability", async () => {
      const session = expectOk(await app.api.get("/auth/session"));
      expect(session.role).toBe("root");
      expect(session.maxLevel).toBe("project_manager");
      expect([...session.capabilities].sort()).toEqual(
        [
          "access.report",
          "agents.manage",
          "agents.view",
          "agents.view_all",
          "audit.read",
          "audit.read_all",
          "audit.verify",
          "grants.all_projects",
          "grants.manage",
          "groups.manage",
          "instance.backup",
          "instance.reset",
          "instance.view",
          "password.breakglass",
          "projects.create",
          "roles.manage",
          "sso.manage",
          "tokens.personal",
          "tokens.revoke_others",
          "users.manage",
          "users.view",
        ].sort(),
      );
    });
    const where = await target({ protected: true });
    const api = await app.apiAs({
      email: "root@dopbase.com",
      password: "e2e-fixture-password-123",
    });
    await runGrid(ACTIONS, [
      {
        label: "root · no grant · protected environment",
        expected: ACTIONS.map(() => "allow" as const),
        run: async () => {
          const results = [];
          for (const action of ACTIONS)
            results.push(await attempt(api, where, action));
          return results;
        },
      },
    ]);
  },
);
