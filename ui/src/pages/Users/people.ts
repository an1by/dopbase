import type { PersonalToken } from "~/services/personal-tokens.api";
import type { Role } from "~/services/roles.api";
import type { User } from "~/services/users.api";
import type { Agent } from "~/services/agents.api";

/** How an account signs in, for the Sign-in column. */
export type SignInMethod = "password" | "sso" | "disabled" | "none";

/** A person or an AI agent, for screens that handle both. */
export type Account = User | Agent;

/** AI agents carry a name where people have an email. */
export function isAgent(account: Account): account is Agent {
  return !("email" in account);
}

/** A person's email or an agent's name. */
export function accountName(account: Account): string {
  return isAgent(account) ? account.name : account.email;
}

/** How full the people limit is. */
export interface UserLimit {
  used: number;
  max: number;
  full: boolean;
}

/**
 * How many spots under the server's people limit are taken, counting the
 * accounts the server marks: active people, never root or AI agents. Null
 * when there is no limit.
 */
export function userLimit(
  accounts: readonly User[],
  max: number | null | undefined,
): UserLimit | null {
  if (!max) return null;
  const used = accounts.filter((account) => account.countsTowardLimit).length;
  return { used, max, full: used >= max };
}

export function signInMethod(user: User): SignInMethod {
  if (user.status === "disabled") return "disabled";
  if (user.ssoLinked && !user.hasPassword) return "sso";
  if (user.hasPassword) return "password";
  return user.ssoLinked ? "sso" : "none";
}

export const SIGN_IN_LABELS: Record<SignInMethod, string> = {
  password: "password",
  sso: "sso",
  disabled: "disabled",
  none: "not set up",
};

/** The role row behind an account, when the roles list has it. */
export function roleOf(user: User, roles: readonly Role[]): Role | null {
  return roles.find((role) => role.id === user.roleId) ?? null;
}

export type TokenState = "active" | "expired" | "revoked";

export function tokenState(token: PersonalToken, now = Date.now()): TokenState {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && Date.parse(token.expiresAt) <= now) return "expired";
  return "active";
}
