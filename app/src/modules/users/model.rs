use crate::{models::AdminRole, modules::grants::model::GroupRef};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Whether an account can sign in and use its tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum UserStatus {
  Active,
  /// Can't sign in, and its sessions and tokens are refused.
  Disabled,
}

impl UserStatus {
  pub fn parse(value: &str) -> Option<Self> {
    match value {
      "active" => Some(Self::Active),
      "disabled" => Some(Self::Disabled),
      _ => None,
    }
  }
}

/// A person's account. AI agents are `AgentResponse`, from
/// `/api/v1/agents`.
#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserResponse {
  /// Unique user identifier with `usr_` prefix.
  pub id: String,
  /// User email address.
  pub email: String,
  /// The fixed role closest to the account's role: `root`, `admin`, or
  /// `member`. Custom roles show as `member`. Prefer `roleId` and
  /// `roleName`.
  pub role: AdminRole,
  /// The account's role. Empty for root, which has no role.
  pub role_id: Option<String>,
  /// The role's name, `Root` for root.
  pub role_name: String,
  /// ISO 8601 creation timestamp.
  pub created_at: String,
  /// ISO 8601 last update timestamp.
  pub updated_at: String,
  /// The account can sign in with a password.
  pub has_password: bool,
  /// The account has a single sign-on identity linked.
  pub sso_linked: bool,
  /// `active` or `disabled`.
  pub status: UserStatus,
  /// ISO 8601 time of the last password, single sign-on, or CLI browser
  /// sign-in. Empty until the first one.
  pub last_sign_in_at: Option<String>,
  /// The groups the account belongs to, by name.
  pub groups: Vec<GroupRef>,
  /// True for the accounts the user limit counts, which are active people
  /// other than root. AI agents never count.
  pub counts_toward_limit: bool,
}

/// Just enough of a person to name them.
#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserIdentity {
  /// Unique user identifier with `usr_` prefix.
  pub id: String,
  /// User email address.
  pub email: String,
}

/// Request to create a new user account.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserRequest {
  /// User email address.
  pub email: String,
  /// Account password (minimum 12 characters). Leave it out to create an
  /// account that signs in only through single sign-on, which must be on.
  #[serde(default)]
  pub password: Option<String>,
  /// A role id from `GET /api/v1/roles`, built-in or custom. Takes
  /// precedence over `role`.
  #[serde(default)]
  pub role_id: Option<String>,
  /// Account role (`admin` or `member`). Defaults to `admin`. AI agents
  /// are added with `POST /api/v1/agents`.
  #[serde(default)]
  pub role: Option<AdminRole>,
  /// Refused with `OWNER_INVALID`: people have no owner.
  #[serde(default)]
  pub owner_id: Option<String>,
}

/// Request to update an existing user account.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUserRequest {
  /// Updated email address.
  pub email: Option<String>,
  /// New account password.
  pub password: Option<String>,
  /// Updated account role (`admin` or `member`).
  pub role: Option<AdminRole>,
  /// A role id from `GET /api/v1/roles`. Takes precedence over `role`.
  #[serde(default)]
  pub role_id: Option<String>,
  /// Refused with `OWNER_INVALID`: people have no owner. AI agents change owner with
  /// `PATCH /api/v1/agents/{id}`.
  #[serde(default)]
  pub owner_id: Option<String>,
}
