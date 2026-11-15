use crate::models::AdminRole;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapStatus {
  pub state: &'static str,
}
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapAdminRequest {
  pub setup_token: String,
  pub email: String,
  pub password: String,
}
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapAdminResponse {
  pub admin_id: String,
  pub email: String,
  pub role: AdminRole,
  pub csrf_token: String,
  pub last_login_at: Option<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapRestoreResponse {
  pub message: String,
  pub restored: bool,
  pub key: String,
  pub size: u64,
  /// What upgrading a 0.1.x backup did, when it was one.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub upgrade: Option<crate::modules::backups::upgrade::UpgradeReport>,
}
