use super::{model::*, repository};
use crate::{
  constants::{
    errors::TOKEN_SCOPE_INVALID,
    limits::{RUNNER_TOKEN_DEFAULT_DAYS, RUNNER_TOKEN_MAX_DAYS},
    tokens::{WORKSPACE_TOKEN_ID_PREFIX, WORKSPACE_TOKEN_PREFIX},
  },
  extractors::{require_person, require_recent_auth},
  http::HttpError,
  models::AuthIdentity,
  modules::common,
  services::token,
  state::AppState,
  utils::time::Stamp,
};
use chrono::{Duration, Utc};

async fn ensure_workspace(pool: &sqlx::SqlitePool, workspace_id: &str) -> Result<(), HttpError> {
  let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspaces WHERE id=$1)")
    .bind(workspace_id)
    .fetch_one(pool)
    .await
    .map_err(HttpError::from)?;
  if exists {
    Ok(())
  } else {
    Err(HttpError::not_found(
      "WORKSPACE_NOT_FOUND",
      "Workspace not found.",
    ))
  }
}

fn lifetime(expires_in: Option<&str>) -> Result<Duration, HttpError> {
  let Some(value) = expires_in else {
    return Ok(Duration::days(RUNNER_TOKEN_DEFAULT_DAYS));
  };
  let invalid = |message: &str| HttpError::bad_request("EXPIRY_INVALID", message);
  let duration = token::expiry_duration(value)
    .map_err(invalid)?
    .ok_or_else(|| invalid("Workspace tokens always expire. Choose a number of hours or days."))?;
  if duration > Duration::days(RUNNER_TOKEN_MAX_DAYS) {
    return Err(invalid(&format!(
      "Workspace tokens last at most {RUNNER_TOKEN_MAX_DAYS} days."
    )));
  }
  Ok(duration)
}

pub async fn list(
  state: &AppState,
  identity: &AuthIdentity,
  workspace_id: &str,
) -> Result<Vec<WorkspaceTokenMetadata>, HttpError> {
  require_person(identity)?;
  ensure_workspace(state.db.pool(), workspace_id).await?;
  Ok(repository::list_workspace(state.db.pool(), workspace_id).await?)
}

pub async fn create(
  state: &AppState,
  identity: &AuthIdentity,
  workspace_id: &str,
  request: CreateTokenRequest,
) -> Result<CreatedWorkspaceTokenResponse, HttpError> {
  let (admin_id, email) = require_person(identity)?;
  if request.role != "workspace" {
    return Err(HttpError::validation(std::collections::BTreeMap::from([(
      TOKEN_SCOPE_INVALID.into(),
      "Only the workspace role is supported by this token endpoint.".into(),
    )])));
  }
  let name = request.name.trim();
  common::validate_slug(name, "TOKEN_NAME_INVALID", "Token name")?;
  ensure_workspace(state.db.pool(), workspace_id).await?;
  require_recent_auth(identity)?;
  let now = Utc::now();
  let expires_at = Some((now + lifetime(request.expires_in.as_deref())?).stamp());
  let token_id = token::public_id(WORKSPACE_TOKEN_ID_PREFIX);
  let raw = token::generate(WORKSPACE_TOKEN_PREFIX).map_err(|_| HttpError::internal())?;
  let now = now.stamp();
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let result = sqlx::query(
    "INSERT INTO workspace_tokens(id, workspace_id, name, token_hash, created_at, expires_at) VALUES($1, $2, $3, $4, $5, $6)",
  )
  .bind(&token_id)
  .bind(workspace_id)
  .bind(name)
  .bind(token::hash(&raw))
  .bind(&now)
  .bind(&expires_at)
  .execute(&mut *tx)
  .await;
  if let Err(error) = result {
    if error.to_string().contains("UNIQUE") {
      return Err(HttpError::conflict(
        "TOKEN_ALREADY_EXISTS",
        "A token with this name already exists in the workspace.",
      ));
    }
    return Err(HttpError::from(error));
  }
  common::audit(
    &mut tx,
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::TokenCreated,
    None,
    None,
    Some("token"),
    Some(&token_id),
    serde_json::json!({"name": name, "scope": "workspace", "workspaceId": workspace_id}),
  )
  .await?;
  tx.commit().await?;
  Ok(CreatedWorkspaceTokenResponse {
    token: WorkspaceTokenMetadata {
      id: token_id,
      workspace_id: workspace_id.into(),
      name: name.into(),
      created_at: now,
      expires_at,
      last_used_at: None,
      revoked_at: None,
    },
    plaintext_token: raw,
  })
}

pub async fn revoke(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
) -> Result<WorkspaceTokenMetadata, HttpError> {
  let (admin_id, email) = require_person(identity)?;
  let token = repository::find_workspace(state.db.pool(), id)
    .await?
    .ok_or_else(|| HttpError::not_found("TOKEN_NOT_FOUND", "The requested token was not found."))?;
  if token.revoked_at.is_some() {
    return Err(HttpError::conflict(
      "TOKEN_REVOKED",
      "The token has already been revoked.",
    ));
  }
  require_recent_auth(identity)?;
  let now = Utc::now().stamp();
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let updated =
    sqlx::query("UPDATE workspace_tokens SET revoked_at=$1 WHERE id=$2 AND revoked_at IS NULL")
      .bind(&now)
      .bind(id)
      .execute(&mut *tx)
      .await?;
  if updated.rows_affected() != 1 {
    return Err(HttpError::conflict(
      "TOKEN_REVOKED",
      "The token has already been revoked.",
    ));
  }
  common::audit(
    &mut tx,
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::TokenRevoked,
    None,
    None,
    Some("token"),
    Some(id),
    serde_json::json!({"name": token.name, "scope": "workspace"}),
  )
  .await?;
  tx.commit().await?;
  repository::find_workspace(state.db.pool(), id)
    .await?
    .ok_or_else(HttpError::internal)
}