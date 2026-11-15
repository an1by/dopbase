//! Fork compatibility helpers for workspace features on top of upstream RBAC.

use crate::{
  constants::errors::AUTHORIZATION_DENIED,
  http::HttpError,
  models::AuthIdentity,
};

/// Workspace management predates granular capabilities; treat it like an
/// authenticated human or personal token action.
pub fn require_project_manager(identity: &AuthIdentity) -> Result<(&str, &str), HttpError> {
  super::require_account(identity).map_err(|_| {
    HttpError::forbidden(
      AUTHORIZATION_DENIED,
      "This operation requires an authenticated account.",
    )
  })
}