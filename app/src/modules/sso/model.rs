use crate::modules::auth::model::LoginResponse;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

/// Which provider the settings were filled in for. Presets only change the
/// Admin UI hints and, for Microsoft, how an email counts as verified.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SsoPreset {
  Generic,
  Google,
  Microsoft,
  Okta,
  Keycloak,
  Auth0,
  Cognito,
  Clerk,
  Supabase,
}

impl SsoPreset {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Generic => "generic",
      Self::Google => "google",
      Self::Microsoft => "microsoft",
      Self::Okta => "okta",
      Self::Keycloak => "keycloak",
      Self::Auth0 => "auth0",
      Self::Cognito => "cognito",
      Self::Clerk => "clerk",
      Self::Supabase => "supabase",
    }
  }

  pub fn parse(value: &str) -> Self {
    match value {
      "google" => Self::Google,
      "microsoft" => Self::Microsoft,
      "okta" => Self::Okta,
      "keycloak" => Self::Keycloak,
      "auth0" => Self::Auth0,
      "cognito" => Self::Cognito,
      "clerk" => Self::Clerk,
      "supabase" => Self::Supabase,
      _ => Self::Generic,
    }
  }
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
  pub preset: SsoPreset,
  pub display_name: String,
  pub issuer: String,
  pub client_id: String,
  /// Required when creating the provider. Leave it out to keep the stored
  /// secret.
  pub client_secret: Option<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
  pub id: String,
  pub preset: SsoPreset,
  pub display_name: String,
  pub issuer: String,
  pub client_id: String,
  pub enabled: bool,
  /// Password login is refused for everyone except root.
  pub require_sso: bool,
  /// The login page shows only the single sign-on button while it is on.
  pub hide_password_form: bool,
  /// When root last completed a test sign-in with these settings.
  pub verified_at: Option<String>,
  pub linked_accounts: i64,
  /// Admins and members without a password, who lose access if single
  /// sign-on is turned off or removed.
  pub passwordless_accounts: i64,
  pub updated_at: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettingsResponse {
  pub provider: Option<ProviderView>,
  /// The redirect URI to register with the provider.
  pub redirect_uri: String,
  /// The public URL the redirect URI is built from.
  pub public_url: String,
  /// Whether the public URL is HTTPS or loopback. Single sign-on cannot be
  /// configured or used otherwise.
  pub public_url_secure: bool,
}

#[derive(Deserialize, ToSchema)]
pub struct EnabledRequest {
  pub enabled: bool,
}

#[derive(Deserialize, ToSchema)]
pub struct PasswordFormRequest {
  pub hidden: bool,
}

#[derive(Deserialize, ToSchema)]
pub struct RequiredRequest {
  pub required: bool,
}

#[derive(Deserialize, IntoParams)]
pub struct StartQuery {
  /// Admin UI path to open after signing in.
  pub redirect: Option<String>,
}

#[derive(Deserialize, IntoParams)]
pub struct CallbackQuery {
  pub code: Option<String>,
  pub state: Option<String>,
  pub error: Option<String>,
}

#[derive(Deserialize, ToSchema)]
pub struct ExchangeRequest {
  pub code: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeResponse {
  pub session: LoginResponse,
  pub redirect_to: Option<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinkResponse {
  pub authorize_url: String,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct IdentityResponse {
  /// Whether the current account can link an identity now.
  pub available: bool,
  pub provider_name: Option<String>,
  pub linked: bool,
  pub email_at_link: Option<String>,
  pub linked_at: Option<String>,
}
