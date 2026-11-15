// Small helpers every suite uses: temp dirs, CLI env for a token, a child
// command for `dopbase run`, and access grants made as root. Setup calls
// here pass { record: false }, so they never count toward coverage.
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "./index.ts";

/** A fresh directory under the file's server root. */
export async function tempDir(app: App, prefix: string): Promise<string> {
  const base = join(app.server.root, "work");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, `${prefix}-`));
}

/** `sh -c` that prints one variable with no newline, for `dopbase run`. */
export function printVar(name: string): string[] {
  return ["sh", "-c", `printf %s "$${name}"`];
}

/** The CLI env for a runner or personal token, with no saved login. */
export function tokenEnv(
  app: App,
  token: string,
  dataDir: string,
): Record<string, string> {
  return {
    ...app.server.cliEnv,
    DOPBASE_TOKEN: token,
    DOPBASE_DATA_DIR: dataDir,
  };
}

export type Level =
  "none" | "metadata" | "read" | "write" | "manage" | "project_manager";

/**
 * Gives `principal` a level on all projects, a project or an environment,
 * as root, through the API.
 */
export async function grant(
  app: App,
  principal: { type?: "user" | "agent" | "group"; id: string },
  level: Level,
  scope: { all: true } | { project: string } | { environment: string } = {
    all: true,
  },
): Promise<{ id: string }> {
  const body =
    "all" in scope
      ? { scopeType: "all" }
      : "project" in scope
        ? { scopeType: "project", scope: scope.project }
        : { scopeType: "environment", scope: scope.environment };
  return app.api.must(
    "PUT",
    "/grants",
    {
      principalType: principal.type ?? "user",
      principalId: principal.id,
      level,
      ...body,
    },
    { record: false },
  );
}
