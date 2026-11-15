import { apiRequest } from "./http.client";
import type { UserAccess } from "./access.api";
import type {
  CreatedPersonalToken,
  CreatePersonalTokenRequest,
  PersonalToken,
} from "./personal-tokens.api";

/**
 * An AI agent: an account that signs in with personal tokens only and has
 * a person who answers for it. It never reaches more than its owner does.
 */
export interface Agent {
  /** `agt_…`, or `usr_…` for an agent restored from 0.1.x. */
  id: string;
  /** Letters, digits, dots, dashes and underscores, like `review-bot`. */
  name: string;
  roleId: string;
  roleName: string;
  /** The person who answers for the agent. */
  ownerId: string;
  /** That person's email, so it shows without listing people. */
  ownerEmail: string | null;
  /** A disabled agent's tokens stop working. */
  status: "active" | "disabled";
  /** The groups the agent belongs to. */
  groups: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

const BASE = "/api/v1/agents";

function item(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

/** The AI agents you may see: all of them, or the ones you own. */
export async function fetchAgents(signal?: AbortSignal): Promise<Agent[]> {
  const { data } = await apiRequest<Agent[]>(BASE, { signal });
  return data;
}

export async function fetchAgent(
  id: string,
  signal?: AbortSignal,
): Promise<Agent> {
  const { data } = await apiRequest<Agent>(item(id), { signal });
  return data;
}

/**
 * Adds an AI agent owned by you. Without `roleId` it gets the built-in AI
 * agent role.
 */
export async function createAgent(
  name: string,
  roleId?: string,
): Promise<Agent> {
  const { data } = await apiRequest<Agent>(BASE, {
    method: "POST",
    body: roleId ? { name, roleId } : { name },
  });
  return data;
}

/**
 * Renames an agent, changes its role, or hands it to another person with
 * `ownerId`. A new owner revokes the agent's tokens.
 */
export async function updateAgent(
  id: string,
  body: { name?: string; roleId?: string; ownerId?: string },
): Promise<Agent> {
  const { data } = await apiRequest<Agent>(item(id), {
    method: "PATCH",
    body,
  });
  return data;
}

export async function deleteAgent(id: string): Promise<void> {
  await apiRequest(item(id), { method: "DELETE" });
}

/** Stops the agent's tokens working until it's turned back on. */
export async function disableAgent(id: string): Promise<Agent> {
  const { data } = await apiRequest<Agent>(`${item(id)}/disable`, {
    method: "POST",
  });
  return data;
}

export async function enableAgent(id: string): Promise<Agent> {
  const { data } = await apiRequest<Agent>(`${item(id)}/enable`, {
    method: "POST",
  });
  return data;
}

/** The agent's role cap, groups and grants. `email` holds its name. */
export async function fetchAgentAccess(
  id: string,
  signal?: AbortSignal,
): Promise<UserAccess> {
  const { data } = await apiRequest<UserAccess>(`${item(id)}/access`, {
    signal,
  });
  return data;
}

export async function listAgentTokens(
  id: string,
  signal?: AbortSignal,
): Promise<PersonalToken[]> {
  const { data } = await apiRequest<PersonalToken[]>(`${item(id)}/tokens`, {
    signal,
  });
  return data;
}

/** The plaintext comes back once, here. */
export async function createAgentToken(
  id: string,
  request: CreatePersonalTokenRequest,
): Promise<CreatedPersonalToken> {
  const { data } = await apiRequest<CreatedPersonalToken>(
    `${item(id)}/tokens`,
    { method: "POST", body: request },
  );
  return data;
}

export async function revokeAgentToken(
  id: string,
  tokenId: string,
): Promise<PersonalToken> {
  const { data } = await apiRequest<PersonalToken>(
    `${item(id)}/tokens/${encodeURIComponent(tokenId)}/revoke`,
    { method: "POST" },
  );
  return data;
}
