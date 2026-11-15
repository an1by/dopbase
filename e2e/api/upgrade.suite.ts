// Upgrading from 0.1.x: back up on 0.1.x, restore on a fresh 0.2.0 (see
// docs/self-hosting/upgrade-to-0-2.md). The backup, its master key and the
// old data dir come from e2e/fixtures/upgrade/v<version>, built by
// `bun run --cwd e2e fixture:upgrade <version>`. Each upgrade-<version>.spec.ts
// runs this suite against one fixture on a server of its own. To cover another
// release, build its fixture and add a spec file that calls upgradeSuite.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../harness/api.ts";
import { about, expect, step, test, useServer } from "../harness/index.ts";
import { freePort, runCli } from "../harness/server.ts";
import {
  ALL_FEATURES,
  expectError,
  expectOk,
  multipart,
  QUIET,
} from "./support.ts";

/** Restores the fixture for `version` on a fresh 0.2.0 and checks what came across. */
export function upgradeSuite(version: string): void {
  const FIXTURE = join(import.meta.dirname, `../fixtures/upgrade/v${version}`);
  const seed = JSON.parse(readFileSync(join(FIXTURE, "seed.json"), "utf8"));
  const [ada, max] = seed.people as {
    id: string;
    email: string;
    password: string;
  }[];

  const app = useServer({ claimRoot: false, env: ALL_FEATURES });

  /** Signs in as `who` on a context of its own and returns a CLI-token client. */
  async function signIn(who: {
    email: string;
    password: string;
  }): Promise<ApiClient> {
    const fresh = await ApiClient.create(app.url, "login", []);
    const login = await fresh.send(
      "POST",
      "/auth/login",
      { email: who.email, password: who.password, sessionKind: "cli" },
      QUIET,
    );
    await fresh.dispose();
    expect(login.ok, `${who.email}: ${JSON.stringify(login.body)}`).toBe(true);
    return ApiClient.create(app.url, who.email, [], {
      authorization: `Bearer ${login.data.token}`,
    });
  }

  test.describe.serial(`restore a ${seed.version} backup`, () => {
    test.beforeAll(() => {
      // The fixture's values count as seeded secrets for the leak check.
      for (const env of Object.values(seed.secrets) as Record<
        string,
        string
      >[]) {
        for (const value of Object.values(env)) app.secrets.add(value);
      }
      app.secrets.add(seed.deletedSecret.value);
    });

    test(
      `the ${seed.version} backup restores on a fresh server`,
      {
        tag: "@upgrade",
        annotation: about(
          `An unclaimed 0.2.0 server takes the ${seed.version} backup and its master key through the setup restore, reports that it upgraded a 0.1.x backup, and is ready.`,
        ),
      },
      async () => {
        const api = await ApiClient.create(app.url, "setup", []);
        const form = () =>
          multipart({
            file: {
              filename: "before-0-2.dop",
              data: readFileSync(join(FIXTURE, "backup.dop")),
            },
            key: readFileSync(join(FIXTURE, "master.key")).toString("hex"),
          });
        await step(
          "POST /bootstrap/restore with the wrong key is refused",
          async () => {
            const wrong = multipart({
              file: {
                filename: "before-0-2.dop",
                data: readFileSync(join(FIXTURE, "backup.dop")),
              },
              key: "00".repeat(32),
            });
            const result = await api.send(
              "POST",
              "/bootstrap/restore",
              wrong.body,
              {
                headers: {
                  ...wrong.headers,
                  "x-dopbase-setup-token": app.server.setupToken ?? "",
                },
              },
            );
            expect(result.status).toBe(400);
            expect(expectOk(await api.get("/bootstrap/status")).state).toBe(
              "setupRequired",
            );
          },
        );
        const report = await step(
          `POST /bootstrap/restore with the ${seed.version} backup and key`,
          async () => {
            const body = form();
            const restored = expectOk(
              await api.send("POST", "/bootstrap/restore", body.body, {
                headers: {
                  ...body.headers,
                  "x-dopbase-setup-token": app.server.setupToken ?? "",
                },
              }),
            );
            expect(restored.restored).toBe(true);
            return restored.upgrade;
          },
        );
        await step("The restore reports an upgrade from 0.1.x", async () => {
          expect(report.upgradedFrom).toBe("0.1.x");
          expect(report.tables.secrets).toBe(3);
          expect(report.tables.projects).toBe(1);
          expect(report.tables.environments).toBe(2);
        });
        await step("GET /bootstrap/status is ready", async () => {
          expect(expectOk(await api.get("/bootstrap/status")).state).toBe(
            "ready",
          );
        });
        await api.dispose();
      },
    );

    test(
      "people, roles, the AI agent and their access come across",
      {
        tag: "@upgrade",
        annotation: about(
          `Root, the ${seed.version} admin and member sign in with their old passwords and keep their roles; the ${seed.version} service account is now an AI agent; 0.1.x's shared projects become all-projects grants: project manager, write and metadata.`,
        ),
      },
      async () => {
        await step("Root signs in with the old password", async () => {
          expect(expectOk(await app.api.get("/auth/session")).role).toBe(
            "root",
          );
        });
        await step(
          "GET /users lists the admin and the member with their roles",
          async () => {
            const users = expectOk(await app.api.get("/users"));
            const byEmail = Object.fromEntries(
              users.map((u: { email: string }) => [u.email, u]),
            );
            expect(byEmail[ada.email]).toMatchObject({
              id: ada.id,
              roleName: "Admin",
              status: "active",
            });
            expect(byEmail[max.email]).toMatchObject({
              id: max.id,
              roleName: "Member",
              status: "active",
            });
          },
        );
        await step(
          `Both sign in with their ${seed.version} passwords`,
          async () => {
            for (const who of [ada, max]) await (await signIn(who)).dispose();
          },
        );
        await step("GET /agents shows deploy-bot as an AI agent", async () => {
          const agents = expectOk(await app.api.get("/agents"));
          expect(agents).toContainEqual(
            expect.objectContaining({
              id: seed.agent.id,
              name: seed.agent.name,
              roleName: "AI agent",
            }),
          );
          const users = expectOk(await app.api.get("/users"));
          expect(users.map((u: { id: string }) => u.id)).not.toContain(
            seed.agent.id,
          );
        });
        // 0.1.x shared every project: the upgrade turns that into grants on
        // all projects, project manager for admins, write for members and
        // metadata for AI agents.
        await step(
          "GET /users/{id}/access: the admin manages all projects",
          async () => {
            const access = expectOk(
              await app.api.get(`/users/${ada.id}/access`),
            );
            expect(access.grants).toEqual([
              expect.objectContaining({
                scopeType: "all",
                level: "project_manager",
              }),
            ]);
          },
        );
        await step(
          "GET /users/{id}/access: the member writes on all projects",
          async () => {
            const access = expectOk(
              await app.api.get(`/users/${max.id}/access`),
            );
            expect(access.grants).toEqual([
              expect.objectContaining({ scopeType: "all", level: "write" }),
            ]);
            const maxApi = await signIn(max);
            expect(
              expectOk(
                await maxApi.post(
                  `/environments/${seed.environments.dev}/secrets/API_KEY/reveal`,
                ),
              ).value,
            ).toBe(seed.secrets.dev.API_KEY);
            expectError(
              await maxApi.patch(`/environments/${seed.environments.dev}`, {
                name: "renamed",
              }),
              403,
              "AUTHORIZATION_DENIED",
            );
            await maxApi.dispose();
          },
        );
        await step(
          "GET /agents/{id}/access: the agent sees names on all projects",
          async () => {
            const access = expectOk(
              await app.api.get(`/agents/${seed.agent.id}/access`),
            );
            expect(access.grants).toEqual([
              expect.objectContaining({ scopeType: "all", level: "metadata" }),
            ]);
          },
        );
      },
    );

    test(
      "projects and secrets with their history come across",
      {
        tag: "@upgrade",
        annotation: about(
          `The project and both environments keep their ids; every secret reveals its ${seed.version} value, API_KEY is still at version 3, the deleted secret stays deleted, and the old runner token still reads its environment and now expires within 365 days.`,
        ),
      },
      async () => {
        await step(
          "GET /environments/resolve finds shop/dev and shop/prod by name",
          async () => {
            for (const [name, id] of Object.entries(
              seed.environments as Record<string, string>,
            )) {
              expect(
                expectOk(
                  await app.api.get(
                    `/environments/resolve?reference=${seed.project.name}/${name}`,
                  ),
                ).id,
              ).toBe(id);
            }
          },
        );
        for (const [env, values] of Object.entries(
          seed.secrets as Record<string, Record<string, string>>,
        )) {
          await step(
            `Every ${env} secret reveals its ${seed.version} value`,
            async () => {
              for (const [key, value] of Object.entries(values)) {
                const revealed = expectOk(
                  await app.api.post(
                    `/environments/${seed.environments[env]}/secrets/${key}/reveal`,
                  ),
                );
                expect(revealed.value).toBe(value);
              }
            },
          );
        }
        await step(
          "API_KEY in dev is at version 3, with its history listed",
          async () => {
            const page = expectOk(
              await app.api.get(
                `/environments/${seed.environments.dev}/secrets/API_KEY/versions`,
              ),
            );
            expect(page.items[0]).toMatchObject({
              version: seed.apiKeyVersion,
              current: true,
            });
          },
        );
        await step(
          `The secret deleted on ${seed.version} is still gone`,
          async () => {
            expectError(
              await app.api.get(
                `/environments/${seed.environments.prod}/secrets/${seed.deletedSecret.key}`,
              ),
              404,
              "SECRET_NOT_FOUND",
            );
          },
        );
        await step(
          `The ${seed.version} runner token still reads dev`,
          async () => {
            const runner = await app.apiWithToken(seed.runnerToken.token);
            const data = expectOk(await runner.get("/runtime/secrets"));
            expect(data.environmentId).toBe(seed.environments.dev);
            expect(data.entries).toHaveLength(2);
            await runner.dispose();
          },
        );
        await step(
          "The runner token, which never expired on 0.1.x, now expires within 365 days",
          async () => {
            const restore = await app.api.must(
              "GET",
              "/audit-events?action=backup.restored_bootstrap",
              undefined,
              QUIET,
            );
            const restoredAt = Date.parse(restore.items[0].createdAt);
            const tokens = expectOk(
              await app.api.get(
                `/environments/${seed.environments.dev}/tokens`,
              ),
            );
            const runner = tokens.find(
              (t: { id: string }) => t.id === seed.runnerToken.id,
            );
            expect(runner?.expiresAt, "the runner token's expiry").toBeTruthy();
            const expiresAt = Date.parse(runner.expiresAt);
            expect(expiresAt).toBeGreaterThan(Date.now());
            expect(expiresAt).toBeLessThanOrEqual(
              restoredAt + 365 * 24 * 60 * 60 * 1000,
            );
          },
        );
        await step(
          `The ${seed.version} agent token lists names but can't reveal (403)`,
          async () => {
            const token = await app.apiWithToken(seed.agent.token);
            const keys = expectOk(
              await token.get(`/environments/${seed.environments.dev}/secrets`),
            ).map((s: { key: string }) => s.key);
            expect(keys.sort()).toEqual(["API_KEY", "DATABASE_URL"]);
            expectError(
              await token.post(
                `/environments/${seed.environments.dev}/secrets/API_KEY/reveal`,
              ),
              403,
              "AUTHORIZATION_DENIED",
            );
            await token.dispose();
          },
        );
      },
    );

    test(
      "the audit log still verifies after the upgrade",
      {
        tag: "@upgrade",
        annotation: about(
          `After the restore, GET /audit-events/verify passes, the ${seed.version} history is kept (in the log or the archive) and the restore itself is recorded.`,
        ),
      },
      async () => {
        await step("GET /audit-events/verify is ok", async () => {
          const report = expectOk(await app.api.get("/audit-events/verify"));
          expect(report).toMatchObject({ ok: true, broken: null });
        });
        await step(
          "The restore is recorded as backup.restored_bootstrap",
          async () => {
            const page = expectOk(
              await app.api.get(
                "/audit-events?action=backup.restored_bootstrap",
              ),
            );
            expect(page.items).toHaveLength(1);
            expect(JSON.stringify(page.items[0].metadata)).toContain("0.1.x");
          },
        );
        await step(`Every ${seed.version} audit event is kept`, async () => {
          const page = expectOk(await app.api.get("/audit-events?limit=200"));
          expect(page.nextCursor, "more than one page of events").toBeNull();
          const restore = await app.api.must(
            "GET",
            "/audit-events?action=backup.restored_bootstrap",
            undefined,
            QUIET,
          );
          const restoredAt = restore.items[0].createdAt;
          const archivedCount =
            restore.items[0].metadata.upgrade?.archivedAuditRecords ?? 0;
          // Events from before the restore came from 0.1.x. Records from
          // before 0.1.x chained its log go to the archive instead.
          const carried = page.items.filter(
            (e: { createdAt: string }) => e.createdAt < restoredAt,
          );
          expect(carried.length + archivedCount).toBeGreaterThanOrEqual(
            seed.auditEventsBefore,
          );
          expect(
            carried.some(
              (e: { action: string; projectId: string | null }) =>
                e.action === "project.created" &&
                e.projectId === seed.project.id,
            ) || archivedCount > 0,
          ).toBe(true);
        });
      },
    );
  });

  test(
    `0.2.0 refuses to start on a ${seed.version} data dir`,
    {
      tag: "@upgrade",
      annotation: about(
        `Pointed at a ${seed.version} data directory, the 0.2.0 server exits with an error that sends the operator to back up and restore, and leaves the directory alone.`,
      ),
    },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "dopbase-e2e-old-"));
      try {
        const untar = spawnSync(
          "tar",
          ["-xzf", join(FIXTURE, "data-dir.tar.gz"), "-C", root],
          { encoding: "utf8" },
        );
        expect(untar.status, `tar failed: ${untar.stderr}`).toBe(0);
        const before = readFileSync(join(root, "data", "dopbase.db")).toString(
          "base64",
        );
        const result = await step(
          `dopbase server start on the ${seed.version} data dir exits`,
          async () => {
            const port = await freePort();
            return runCli(
              [
                "--data-dir",
                join(root, "data"),
                "server",
                "start",
                "--host",
                "127.0.0.1",
                "--port",
                String(port),
                "--public-url",
                `http://127.0.0.1:${port}`,
              ],
              { env: { HOME: root }, timeoutMs: 20_000 },
            );
          },
        );
        await step(
          "It exits non-zero and points at backup and restore",
          async () => {
            expect(result.code, `${result.stdout}\n${result.stderr}`).not.toBe(
              0,
            );
            expect(result.code).not.toBeNull();
            expect(`${result.stdout}\n${result.stderr}`).toMatch(
              /backup|restore/i,
            );
          },
        );
        await step("The old database is unchanged", async () => {
          expect(
            readFileSync(join(root, "data", "dopbase.db")).toString("base64"),
          ).toBe(before);
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
