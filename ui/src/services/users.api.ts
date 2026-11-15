import { apiRequest } from "./http.client";
import type { AccountRole } from "./auth.api";

/** A person who signs in. AI agents have their own API in `agents.api`. */
export interface User {
  id: string;
  email: string;
  /** The fixed role closest to the account's role. Prefer `roleName`. */
  role: "root" | "admin" | "member";
  /** Empty for root. */
  roleId?: string | null;
  /** `Root` for root. */
  roleName?: string;
  createdAt: string;
  updatedAt: string;
  hasPassword: boolean;
  ssoLinked: boolean;
  /** A disabled account can't sign in, and its tokens stop working. */
  status: "active" | "disabled";
  /** The last interactive sign-in, or null if they never signed in. */
  lastSignInAt: string | null;
  /** The groups the account belongs to. */
  groups: { id: string; name: string }[];
  /**
   * True for the accounts the user limit counts: active people other than
   * root.
   */
  countsTowardLimit: boolean;
}
/** Just enough of a person to name them. */
export type UserIdentity = Pick<User, "id" | "email">;

const BASE = "/api/v1/users";
export async function fetchUsers(signal?: AbortSignal): Promise<User[]> {
  const { data } = await apiRequest<User[]>(BASE, { signal });
  return data;
}

/** Every person's id and email, by email. Lighter than `fetchUsers`. */
export async function fetchUserIdentities(
  signal?: AbortSignal,
): Promise<UserIdentity[]> {
  const { data } = await apiRequest<UserIdentity[]>(`${BASE}/identities`, {
    signal,
  });
  return data;
}

/**
 * Adds a person. Leave `password` empty for someone who uses single sign-on
 * only. Token-only roles are refused; AI agents are added with
 * `createAgent`.
 */
export async function createUser(
  email: string,
  password: string,
  role:
    Exclude<AccountRole, "root" | "ai_agent"> | { roleId: string } = "member",
): Promise<User> {
  const chosen = typeof role === "string" ? { role } : role;
  const { data } = await apiRequest<User>(BASE, {
    method: "POST",
    body: password ? { email, password, ...chosen } : { email, ...chosen },
  });
  return data;
}

export async function updateUser(
  id: string,
  body: {
    email?: string;
    password?: string;
    role?: Exclude<AccountRole, "root" | "ai_agent">;
    roleId?: string;
  },
): Promise<User> {
  const { data } = await apiRequest<User>(`${BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
  return data;
}

export async function deleteUser(id: string): Promise<void> {
  await apiRequest(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Remove a user's single sign-on link. */
export async function unlinkUserSso(id: string): Promise<User> {
  const { data } = await apiRequest<User>(
    `${BASE}/${encodeURIComponent(id)}/sso`,
    { method: "DELETE" },
  );
  return data;
}

export async function fetchUser(
  id: string,
  signal?: AbortSignal,
): Promise<User> {
  const { data } = await apiRequest<User>(`${BASE}/${encodeURIComponent(id)}`, {
    signal,
  });
  return data;
}

/** Stop a person signing in; their sessions end and their tokens stop. */
export async function disableUser(id: string): Promise<User> {
  const { data } = await apiRequest<User>(
    `${BASE}/${encodeURIComponent(id)}/disable`,
    { method: "POST" },
  );
  return data;
}

export async function enableUser(id: string): Promise<User> {
  const { data } = await apiRequest<User>(
    `${BASE}/${encodeURIComponent(id)}/enable`,
    { method: "POST" },
  );
  return data;
}
