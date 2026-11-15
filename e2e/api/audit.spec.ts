import { grant } from "../harness/helpers.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import {
  ALL_FEATURES,
  auditEvents,
  expectError,
  expectOk,
  QUIET,
  type AuditEvent,
} from "./support.ts";

const app = useServer({ env: ALL_FEATURES });

/** The newest event with `action` matching `where`, read as root. */
async function latest(
  action: string,
  where: Partial<AuditEvent> = {},
): Promise<AuditEvent> {
  const events = await auditEvents(app, { action });
  const event = events.find((e) =>
    Object.entries(where).every(
      ([key, value]) => (e as Record<string, unknown>)[key] === value,
    ),
  );
  expect(
    event,
    `no ${action} event matching ${JSON.stringify(where)}`,
  ).toBeTruthy();
  return event!;
}

test(
  "every write leaves an event with its actor and target",
  {
    tag: "@audit",
    annotation: about(
      "Root creates a project, an environment, a secret (then updates, reveals and deletes it), a runner token, a person, a grant and a group; each leaves the expected audit event naming root and what changed.",
    ),
  },
  async () => {
    const session = expectOk(await app.api.get("/auth/session"));
    const root = { actorId: session.adminId, actorLabel: session.email };
    const project = await app.make.project();
    const env = await app.make.environment({ project });
    await app.make.secret(env, "API_KEY");
    await app.make.secret(env, "API_KEY");
    await app.api.must(
      "POST",
      `/environments/${env.id}/secrets/API_KEY/reveal`,
      {},
      QUIET,
    );
    await app.api.must(
      "DELETE",
      `/environments/${env.id}/secrets/API_KEY`,
      undefined,
      QUIET,
    );
    const token = await app.api.must(
      "POST",
      `/environments/${env.id}/tokens`,
      { name: "audit-ci", role: "runner" },
      QUIET,
    );
    await app.api.must("POST", `/tokens/${token.token.id}/revoke`, {}, QUIET);
    const user = await app.make.user();
    const saved = await grant(app, user, "read", { project: project.id });
    const group = (
      await app.api.must(
        "POST",
        "/groups",
        { name: app.uniq("Auditors") },
        QUIET,
      )
    ).group;

    const expected: [string, Partial<AuditEvent>][] = [
      [
        "project.created",
        {
          projectId: project.id,
          resourceType: "project",
          resourceId: project.id,
        },
      ],
      [
        "environment.created",
        {
          projectId: project.id,
          environmentId: env.id,
          resourceType: "environment",
          resourceId: env.id,
        },
      ],
      [
        "secret.created",
        {
          environmentId: env.id,
          projectId: project.id,
          resourceType: "secret",
          resourceId: "API_KEY",
        },
      ],
      [
        "secret.updated",
        {
          environmentId: env.id,
          resourceType: "secret",
          resourceId: "API_KEY",
        },
      ],
      [
        "secret.revealed",
        {
          environmentId: env.id,
          resourceType: "secret",
          resourceId: "API_KEY",
        },
      ],
      [
        "secret.deleted",
        {
          environmentId: env.id,
          resourceType: "secret",
          resourceId: "API_KEY",
        },
      ],
      ["token.created", { environmentId: env.id, resourceId: token.token.id }],
      ["token.revoked", { environmentId: env.id, resourceId: token.token.id }],
      ["admin.created", { resourceId: user.id }],
      ["grant.set", { projectId: project.id, resourceId: saved.id }],
      ["group.created", { resourceId: group.id }],
    ];
    for (const [action, where] of expected) {
      await step(
        `GET /audit-events?action=${action} names root and the target`,
        async () => {
          const event = await latest(action, where);
          expect(event).toMatchObject({ actorType: "root", ...root });
        },
      );
    }
    await step("No event carries a secret value", async () => {
      const all = JSON.stringify(
        await auditEvents(app, { projectId: project.id }),
      );
      for (const value of app.secrets) expect(all).not.toContain(value);
    });
  },
);

test(
  "audit filters and paging",
  {
    tag: "@audit",
    annotation: about(
      "GET /audit-events filters by action, project, environment and actor, and pages with limit and nextCursor without repeating events; a bad cursor is 400.",
    ),
  },
  async () => {
    const project = await app.make.project();
    const env = await app.make.environment({ project });
    for (const key of ["A", "B", "C"]) await app.make.secret(env, key);
    const member = await app.make.user();
    const memberApi = await app.apiAs(member);
    await grant(app, member, "write", { project: project.id });
    await memberApi.must(
      "PUT",
      `/environments/${env.id}/secrets/MEMBER_KEY`,
      { value: app.value() },
      QUIET,
    );
    await step("Filter by action", async () => {
      const page = expectOk(
        await app.api.get(
          `/audit-events?action=secret.created&projectId=${project.id}`,
        ),
      );
      expect(page.items).toHaveLength(4);
      expect(new Set(page.items.map((e: AuditEvent) => e.action))).toEqual(
        new Set(["secret.created"]),
      );
    });
    await step("Filter by environment", async () => {
      const page = expectOk(
        await app.api.get(`/audit-events?environmentId=${env.id}`),
      );
      expect(
        page.items.every((e: AuditEvent) => e.environmentId === env.id),
      ).toBe(true);
      expect(page.items.length).toBeGreaterThanOrEqual(5);
    });
    await step("Filter by actor", async () => {
      const page = expectOk(
        await app.api.get(
          `/audit-events?actor=${member.id}&projectId=${project.id}`,
        ),
      );
      expect(page.items.map((e: AuditEvent) => e.resourceId)).toEqual([
        "MEMBER_KEY",
      ]);
    });
    await step("Page through the project's events two at a time", async () => {
      const all = expectOk(
        await app.api.get(`/audit-events?projectId=${project.id}&limit=200`),
      ).items;
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = `/audit-events?projectId=${project.id}&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
        const page: { items: AuditEvent[]; nextCursor: string | null } =
          expectOk(await app.api.get(query));
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((e: AuditEvent) => e.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all.map((e: AuditEvent) => e.id));
      expect(new Set(seen).size).toBe(seen.length);
    });
    await step("A bad cursor is 400", async () => {
      expectError(
        await app.api.get("/audit-events?cursor=%%%"),
        400,
        "REQUEST_INVALID",
      );
    });
    await step(
      "A Member without audit.read sees only their own events",
      async () => {
        const page = expectOk(
          await memberApi.get(`/audit-events?projectId=${project.id}`),
        );
        expect(page.items.length).toBeGreaterThan(0);
        expect(
          page.items.every((e: AuditEvent) => e.actorId === member.id),
        ).toBe(true);
      },
    );
    await step("Without a session the audit log is 401", async () => {
      expectError(await (await app.anonymousApi()).get("/audit-events"), 401);
    });
  },
);

test(
  "audit-events/verify passes",
  {
    tag: "@audit",
    annotation: about(
      "The hash chain verifies after all this file's writes, also against an anchor taken from a real event; a half anchor is 400 and a role without audit.verify gets 403.",
    ),
  },
  async () => {
    const env = await app.make.environment();
    await app.make.secret(env, "API_KEY");
    const report = await step("GET /audit-events/verify", async () => {
      const result = expectOk(await app.api.get("/audit-events/verify"));
      expect(result).toMatchObject({ ok: true, broken: null });
      expect(result.records).toBeGreaterThan(5);
      return result;
    });
    await step("Verify against the head as an anchor", async () => {
      const result = expectOk(
        await app.api.get(
          `/audit-events/verify?anchorSeq=${report.headSeq}&anchorHash=${report.headHash}`,
        ),
      );
      expect(result.ok).toBe(true);
      expect(result.anchor).toBeTruthy();
    });
    await step("A wrong anchor hash fails verification", async () => {
      const result = expectOk(
        await app.api.get(
          `/audit-events/verify?anchorSeq=${report.headSeq}&anchorHash=${"0".repeat(64)}`,
        ),
      );
      expect(result.ok).toBe(false);
      expect(result.anchor.status).toBe("mismatch");
    });
    await step("anchorSeq without anchorHash is 400", async () => {
      expectError(
        await app.api.get(`/audit-events/verify?anchorSeq=${report.headSeq}`),
        400,
        "REQUEST_INVALID",
      );
    });
    await step("A Member can't verify (403), an Auditor can", async () => {
      const member = await app.apiAs(await app.make.user());
      expectError(
        await member.get("/audit-events/verify"),
        403,
        "AUTHORIZATION_DENIED",
      );
      const auditor = await app.apiAs(await app.make.user({ role: "Auditor" }));
      expect(expectOk(await auditor.get("/audit-events/verify")).ok).toBe(true);
    });
    await step("Without a session verify is 401", async () => {
      expectError(
        await (await app.anonymousApi()).get("/audit-events/verify"),
        401,
      );
    });
  },
);
