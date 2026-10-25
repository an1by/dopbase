import { apiRequest } from "./http.client";

export type SsoPreset =
  | "generic"
  | "google"
  | "microsoft"
  | "okta"
  | "keycloak"
  | "auth0"
  | "cognito"
  | "clerk"
  | "supabase";

export interface SsoProvider {
  id: string;
  preset: SsoPreset;
  displayName: string;
  issuer: string;
  clientId: string;
  enabled: boolean;
  /** Password login is refused for everyone except root. */
  requireSso: boolean;
  /** The login page shows only the single sign-on button. */
  hidePasswordForm: boolean;
  /** Set once root completes a test sign-in with the current settings. */
  verifiedAt: string | null;
  linkedAccounts: number;
  /** Admins and members who lose access if single sign-on goes away. */
  passwordlessAccounts: number;
  updatedAt: string;
}

export interface SsoSettings {
  provider: SsoProvider | null;
  /** Register this redirect URI with the identity provider. */
  redirectUri: string;
  /** The server's public URL, which the redirect URI is built from. */
  publicUrl: string;
  /** Single sign-on cannot be set up or used unless this is true. */
  publicUrlSecure: boolean;
}

export interface SaveSsoProviderRequest {
  preset: SsoPreset;
  displayName: string;
  issuer: string;
  clientId: string;
  /** Leave out to keep the stored secret. */
  clientSecret?: string;
}

const BASE = "/api/v1/sso/provider";

export async function fetchSsoSettings(): Promise<SsoSettings> {
  const { data } = await apiRequest<SsoSettings>(BASE);
  return data;
}

export async function saveSsoProvider(
  request: SaveSsoProviderRequest,
): Promise<SsoSettings> {
  const { data } = await apiRequest<SsoSettings>(BASE, {
    method: "PUT",
    body: request,
  });
  return data;
}

export async function setSsoEnabled(enabled: boolean): Promise<SsoSettings> {
  const { data } = await apiRequest<SsoSettings>(`${BASE}/enabled`, {
    method: "PUT",
    body: { enabled },
  });
  return data;
}

export async function deleteSsoProvider(): Promise<void> {
  await apiRequest(BASE, { method: "DELETE" });
}

export async function setSsoRequired(required: boolean): Promise<SsoSettings> {
  const { data } = await apiRequest<SsoSettings>(`${BASE}/required`, {
    method: "PUT",
    body: { required },
  });
  return data;
}

export async function setSsoPasswordFormHidden(
  hidden: boolean,
): Promise<SsoSettings> {
  const { data } = await apiRequest<SsoSettings>(`${BASE}/password-form`, {
    method: "PUT",
    body: { hidden },
  });
  return data;
}
