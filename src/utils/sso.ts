/**
 * Messages for the `sso_error` reasons the server puts in its redirects.
 * Unknown reasons fall back to the generic one.
 */
const messages: Record<string, string> = {
  disabled: "Single sign-on is turned off. Sign in with your password.",
  unavailable: "Couldn't reach the identity provider. Try again in a moment.",
  failed:
    "Single sign-on didn't work. Try again, or sign in with your password.",
  expired:
    "This sign-in expired or was opened in another browser. Start again.",
  cancelled: "Sign-in was cancelled at the identity provider.",
  rate_limited: "Too many failed sign-ins. Wait a few minutes and try again.",
  account_not_found:
    "No Dopbase account uses that email. Ask an administrator to create one.",
  email_unverified:
    "Your identity provider hasn't verified that email, so Dopbase can't match it to an account. Sign in with your password, then link single sign-on from the Account page.",
  root_not_linked:
    "The root account uses single sign-on only after it's linked on the single sign-on settings page.",
  identity_taken: "That identity is already linked to another Dopbase account.",
  identity_mismatch:
    "A different account signed in at the provider. Sign in as yourself and try again.",
  reauth_not_fresh:
    "The provider didn't ask you to sign in again, so Dopbase couldn't confirm it's you. Sign out of the provider and try again.",
  already_linked:
    "This account is already linked to a different identity at the provider.",
};

export function ssoErrorMessage(reason: unknown): string | null {
  if (typeof reason !== "string" || reason === "") return null;
  return messages[reason] ?? messages.failed ?? null;
}
