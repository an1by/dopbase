use super::presets::Preset;
use crate::modules::auth::model::LoginResponse;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

/// A provider preset from `presets.toml`, as the Admin UI shows it.
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PresetView {
  pub id: String,
  pub label: String,
  /// The default sign-in button label.
  pub button_label: String,
  /// An example issuer URL.
  pub issuer: String,
  pub hint: String,
}

impl From<&Preset> for PresetView {
  fn from(preset: &Preset) -> Self {
    Self {
      id: preset.id.clone(),
      label: preset.label.clone(),
      button_label: preset.button_label.clone(),
      issuer: preset.issuer.clone(),
      hint: preset.hint.clone(),
    }
  }
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRequest {
  /// The ID of a preset from `presets`.
  pub preset: String,
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
  pub preset: String,
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
  /// The providers root can pick from, in display order.
  pub presets: Vec<PresetView>,
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
