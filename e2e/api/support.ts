// Helpers shared by the API specs. Setup calls here pass { record: false },
// so they never count toward route coverage; the specs make the calls they
// test themselves.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ROOT,
  expect,
  type ApiResult,
  type App,
  type Environment,
  type User,
} from "../harness/index.ts";
import { ApiClient } from "../harness/api.ts";
import type { Level } from "../harness/helpers.ts";
import { startServer } from "../harness/server.ts";

/** Every optional feature on: people and groups, custom roles, SSO. */
export const ALL_FEATURES: Record<string, string> = {
  DOPBASE_RBAC: "true",
  DOPBASE_RBAC_ROLES: "true",
  DOPBASE_SSO: "true",
};

export const QUIET = { record: false } as const;

/** Asserts an error answer: the status and the error code in `error`. */
export function expectError(
  result: ApiResult,
  status: number,
  code?: string,
): void {
  const detail = `${status} ${code ?? ""} expected, got ${result.status} ${JSON.stringify(result.body)}`;
  expect(result.status, detail).toBe(status);
  expect(result.body?.success, detail).toBe(false);
  if (code)
    expect(Object.keys(result.body?.error ?? {}), detail).toContain(code);
}

/** Asserts a 2xx answer with `success: true` and returns `data`. */
export function expectOk<T = any>(result: ApiResult<T>, status = 200): T {
  expect(
    result.status,
    `expected ${status}, got ${result.status} ${JSON.stringify(result.body)}`,
  ).toBe(status);
  expect(result.body?.success).toBe(true);
  return result.data;
}

/**
 * A new browser session for `account`, not cached like `app.apiAs`. For
 * tests that end sessions (role changes, password changes, logout) and
 * need to sign in again. Dispose it when done.
 */
export function freshSession(
  app: App,
  account: { email: string; password: string },
): Promise<ApiClient> {
  return ApiClient.signIn(app.url, account);
}

/** A role id by name, or a new custom role. */
export async function customRole(
  app: App,
  opts: {
    name?: string;
    maxLevel?: Level;
    capabilities?: string[];
    tokenMaxLevel?: Level;
  } = {},
): Promise<{ id: string; name: string }> {
  return app.api.must(
    "POST",
    "/roles",
    {
      name: opts.name ?? app.uniq("role"),
      maxLevel: opts.maxLevel ?? "project_manager",
      capabilities: opts.capabilities ?? [],
      ...(opts.tokenMaxLevel ? { tokenMaxLevel: opts.tokenMaxLevel } : {}),
    },
    QUIET,
  );
}

/** A person with a role given by id (custom roles) instead of name. */
export async function userWithRole(app: App, roleId: string): Promise<User> {
  const email = `${app.uniq("user")}@dopbase.com`;
  const password = `pw-${randomBytes(12).toString("hex")}`;
  const created = await app.api.must(
    "POST",
    "/users",
    { email, password, roleId },
    QUIET,
  );
  return { ...created, email, password };
}

/** An AI agent, owned by root unless `as` (its creator) is given. */
export async function agent(
  app: App,
  opts: { as?: ApiClient; name?: string } = {},
): Promise<{ id: string; name: string; ownerId: string }> {
  const api = opts.as ?? app.api;
  return api.must(
    "POST",
    "/agents",
    { name: opts.name ?? app.uniq("bot") },
    QUIET,
  );
}

/** A personal token for a person (`/users`) or an AI agent (`/agents`). */
export async function personalToken(
  app: App,
  owner: { id: string; kind?: "users" | "agents" },
  opts: {
    as?: ApiClient;
    level?: Level;
    scopeType?: "all" | "project" | "environment" | "audit";
    scope?: string;
    name?: string;
  } = {},
): Promise<{ id: string; token: string }> {
  const api = opts.as ?? app.api;
  const created = await api.must(
    "POST",
    `/${owner.kind ?? "users"}/${owner.id}/tokens`,
    {
      name: opts.name ?? app.uniq("tok"),
      level: opts.level ?? "read",
      scopeType: opts.scopeType ?? "all",
      ...(opts.scope ? { scope: opts.scope } : {}),
      expiresIn: "7d",
    },
    QUIET,
  );
  return { id: created.token.id, token: created.plaintextToken };
}

/** A runner token for `env`, as root. */
export async function runnerToken(
  app: App,
  env: Environment,
  name = app.uniq("runner"),
): Promise<{ id: string; token: string }> {
  const created = await app.api.must(
    "POST",
    `/environments/${env.id}/tokens`,
    { name, role: "runner" },
    QUIET,
  );
  return { id: created.token.id, token: created.plaintextToken };
}

export type AuditEvent = {
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  projectId: string | null;
  environmentId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, any>;
  createdAt: string;
  seq: number;
};

/** Root's view of the audit log, newest first, filtered by `query`. */
export async function auditEvents(
  app: App,
  query: Record<string, string> = {},
): Promise<AuditEvent[]> {
  const params = new URLSearchParams({ limit: "200", ...query });
  const page = await app.api.must(
    "GET",
    `/audit-events?${params}`,
    undefined,
    QUIET,
  );
  return page.items;
}

/** A multipart/form-data body for `send(…, { headers })`. */
export function multipart(
  fields: Record<
    string,
    string | { filename: string; data: ArrayLike<number> }
  >,
): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----e2e${randomBytes(8).toString("hex")}`;
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    const head =
      typeof value === "string"
        ? `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`
        : `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${value.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    parts.push(new TextEncoder().encode(head));
    parts.push(
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : new Uint8Array(value.data),
    );
    parts.push(new TextEncoder().encode("\r\n"));
  }
  parts.push(new TextEncoder().encode(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** A backup file in this server's data dir, read from disk. */
export function readBackupFile(app: App, key: string): Promise<Buffer> {
  return readFile(join(app.dataDir, "backups", key));
}

/** The master key file of a data dir, as the hex string restore accepts. */
export async function masterKeyHex(dataDir: string): Promise<string> {
  const bytes = await readFile(join(dataDir, "master.key"));
  const text = bytes.toString("utf8").trim();
  return /^[0-9a-f]{64}$/i.test(text) ? text : bytes.toString("hex");
}

/** Calls the API of a server the file doesn't own, as root. */
export type SeedCall = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<any>;

/**
 * Boots a second, throwaway server, lets `seed` set it up through the API
 * as root, then hands its data dir to `keep` before stopping it.
 */
export async function withSeedServer<T>(
  env: Record<string, string>,
  seed: (call: SeedCall) => Promise<T>,
  keep: (dataDir: string, seeded: T) => Promise<void> = async () => {},
): Promise<T> {
  const source = await startServer({ env });
  try {
    // A browser session: some writes, such as adding people, only take one.
    const api = await ApiClient.signIn(source.url, ROOT);
    try {
      const seeded = await seed((method, path, body) =>
        api.must(method, path, body, QUIET),
      );
      await keep(source.dataDir, seeded);
      return seeded;
    } finally {
      await api.dispose();
    }
  } finally {
    await source.stop();
  }
}

/**
 * Seeds one project with a secret on a throwaway 0.2.0 server, takes a
 * backup and returns the file, its master key and what it holds. For tests
 * that restore a backup onto a fresh server.
 */
export async function backupFromAnotherServer(value: string): Promise<{
  file: Buffer;
  masterKey: string;
  project: string;
  environment: string;
  key: string;
  value: string;
}> {
  const project = `restored-${randomBytes(3).toString("hex")}`;
  const key = "RESTORED_KEY";
  let file = Buffer.alloc(0);
  let masterKey = "";
  await withSeedServer(
    {},
    async (call) => {
      await call("POST", "/projects", { name: project });
      const env = await call("POST", `/projects/${project}/environments`, {
        name: "prod",
      });
      await call("PUT", `/environments/${env.id}/secrets/${key}`, { value });
      return call("POST", "/backups", { name: "seed" });
    },
    async (dataDir, backup) => {
      file = await readFile(join(dataDir, "backups", backup.key));
      masterKey = await masterKeyHex(dataDir);
    },
  );
  return { file, masterKey, project, environment: "prod", key, value };
}
