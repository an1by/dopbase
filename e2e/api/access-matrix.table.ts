// The expected outcome of every cell in access-matrix.spec.ts, written out
// by hand from CONTEXT.md and app/src/services/authx.rs so a change in the
// rules shows up as a diff here, not as a silent change in the test.
//
// Each row is one account holding one grant on a project; each column is
// one thing it tries on an unprotected environment of that project.

export type Outcome = "allow" | "deny";
const Y: Outcome = "allow";
const N: Outcome = "deny";

export const LEVELS = [
  "none",
  "metadata",
  "read",
  "write",
  "manage",
  "project_manager",
] as const;
export type Level = (typeof LEVELS)[number];

export const ACTIONS = [
  "list",
  "read value",
  "write",
  "manage env",
  "create token",
  "read audit",
] as const;
export type Action = (typeof ACTIONS)[number];

/** What each column does. */
export const ACTION_HELP: Record<Action, string> = {
  list: "GET /environments/{id}/secrets",
  "read value": "POST /environments/{id}/secrets/API_KEY/reveal",
  write: "PUT /environments/{id}/secrets/API_KEY",
  "manage env": "PATCH /environments/{id}",
  "create token": "POST /environments/{id}/tokens",
  "read audit": "GET /audit-events?projectId= shows root's project.created",
};

/**
 * The accounts the matrix runs as. Built-in roles act through a browser
 * session, except the AI agent, which only has personal tokens: its token
 * (level write, all projects) is made by root, who also owns the agent.
 * The custom role is created by the test with `CUSTOM_ROLE` below. Root
 * gives every Admin it creates project manager on all projects; the matrix
 * removes that grant so each row shows the project grant alone.
 */
export const SUBJECTS = [
  "Admin",
  "Member",
  "Auditor",
  "AI agent",
  "Custom",
] as const;
export type Subject = (typeof SUBJECTS)[number];

/** The custom role the matrix creates: ceiling read, plus audit.read. */
export const CUSTOM_ROLE = {
  maxLevel: "read" as Level,
  capabilities: ["audit.read", "tokens.personal"],
};

/** Each role's ceiling. A grant above it is given through a group instead. */
export const CEILING: Record<Subject, Level> = {
  Admin: "project_manager",
  Member: "manage",
  Auditor: "metadata",
  "AI agent": "write",
  Custom: CUSTOM_ROLE.maxLevel,
};

type Row = [Outcome, Outcome, Outcome, Outcome, Outcome, Outcome];

// Columns: list, read value, write, manage env, create token, read audit.
// prettier-ignore
export const EXPECTED: Record<Subject, Record<Level, Row>> = {
  // Ceiling project manager, audit.read: sees audit on projects it reaches.
  Admin: {
    none:            [N, N, N, N, N, N],
    metadata:        [Y, N, N, N, N, Y],
    read:            [Y, Y, N, N, N, Y],
    write:           [Y, Y, Y, N, N, Y],
    manage:          [Y, Y, Y, Y, Y, Y],
    project_manager: [Y, Y, Y, Y, Y, Y],
  },
  // Ceiling manage, no audit.read: only ever its own audit events.
  Member: {
    none:            [N, N, N, N, N, N],
    metadata:        [Y, N, N, N, N, N],
    read:            [Y, Y, N, N, N, N],
    write:           [Y, Y, Y, N, N, N],
    manage:          [Y, Y, Y, Y, Y, N],
    project_manager: [Y, Y, Y, Y, Y, N],
  },
  // Ceiling metadata, audit.read_all: names only, but every audit event.
  Auditor: {
    none:            [N, N, N, N, N, Y],
    metadata:        [Y, N, N, N, N, Y],
    read:            [Y, N, N, N, N, Y],
    write:           [Y, N, N, N, N, Y],
    manage:          [Y, N, N, N, N, Y],
    project_manager: [Y, N, N, N, N, Y],
  },
  // Ceiling write, tokens only: a data token never manages or reads audit.
  "AI agent": {
    none:            [N, N, N, N, N, N],
    metadata:        [Y, N, N, N, N, N],
    read:            [Y, Y, N, N, N, N],
    write:           [Y, Y, Y, N, N, N],
    manage:          [Y, Y, Y, N, N, N],
    project_manager: [Y, Y, Y, N, N, N],
  },
  // Ceiling read, audit.read.
  Custom: {
    none:            [N, N, N, N, N, N],
    metadata:        [Y, N, N, N, N, Y],
    read:            [Y, Y, N, N, N, Y],
    write:           [Y, Y, N, N, N, Y],
    manage:          [Y, Y, N, N, N, Y],
    project_manager: [Y, Y, N, N, N, Y],
  },
};

/**
 * A protected environment: an Admin's project grant below project manager
 * doesn't reach it, project manager does (as manage), and an environment
 * grant reaches it at its own level.
 */
// Columns: list, read value, write, manage env, create token, read audit.
// prettier-ignore
export const PROTECTED: Record<string, Row> = {
  "project grant · metadata":        [N, N, N, N, N, Y],
  "project grant · read":            [N, N, N, N, N, Y],
  "project grant · write":           [N, N, N, N, N, Y],
  "project grant · manage":          [N, N, N, N, N, Y],
  "project grant · project_manager": [Y, Y, Y, Y, Y, Y],
  "environment grant · read":        [Y, Y, N, N, N, Y],
  "environment grant · manage":      [Y, Y, Y, Y, Y, Y],
};

/**
 * Group and direct grants for a Member. Within one tier the higher level
 * wins; a more specific tier wins even when it is lower.
 */
// Columns: list, read value, write, manage env.
// prettier-ignore
export const COMBINED: Record<string, [Outcome, Outcome, Outcome, Outcome]> = {
  "group project read + direct project write":          [Y, Y, Y, N],
  "group project manage + direct project read":         [Y, Y, Y, Y],
  "group project manage + direct environment read":     [Y, Y, N, N],
  "direct project manage + group environment metadata": [Y, N, N, N],
  "group all-projects write + nothing else":            [Y, Y, Y, N],
  "two groups: project read and project write":         [Y, Y, Y, N],
};

/**
 * Personal and agent tokens. The owner is a Member; each token reaches at
 * most what its owner and its own scope and level allow.
 */
// Columns: list, read value, write.
// prettier-ignore
export const TOKENS: Record<string, [Outcome, Outcome, Outcome]> = {
  "owner write · token read, all projects":        [Y, Y, N],
  "owner write · token write, all projects":       [Y, Y, Y],
  "owner read · token write, all projects":        [Y, Y, N],
  "owner metadata · token write, all projects":    [Y, N, N],
  "owner write · token write, other project only": [N, N, N],
  "owner write · token write, this environment":   [Y, Y, Y],
  "agent write · owner read · token write":        [Y, Y, N],
  "agent write · owner write · token read":        [Y, Y, N],
  "agent read · owner write · token write":        [Y, Y, N],
  "agent write · owner none · token write":        [N, N, N],
};
