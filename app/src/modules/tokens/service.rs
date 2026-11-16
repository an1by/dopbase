use super::{model::*, repository};
use crate::modules::common;
use crate::utils::time::Stamp;
use crate::{
  constants::{
    errors::TOKEN_SCOPE_INVALID,
    limits::{RUNNER_TOKEN_DEFAULT_DAYS, RUNNER_TOKEN_MAX_DAYS},
    tokens::{RUNNER_TOKEN_ID_PREFIX, RUNNER_TOKEN_PREFIX},
  },
  extractors::{require_person, require_recent_auth},
  http::HttpError,
  models::AuthIdentity,
  modules::environments::service::authorize,
  services::{authx::Level, token},
  state::AppState,
};
use chrono::{Duration, Utc};
pub async fn list(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
) -> Result<Vec<TokenMetadata>, HttpError> {
  require_person(identity)?;
  authorize(state, identity, id, Level::Manage).await?;
  Ok(repository::list(state.db.pool(), id).await?)
}
/// How long a new runner token lives: 90 days unless asked otherwise, and
/// never longer than a year.
pub(crate) fn token_lifetime(
  expires_in: Option<&str>,
  kind: &str,
) -> Result<Duration, HttpError> {
  let Some(value) = expires_in else {
    return Ok(Duration::days(RUNNER_TOKEN_DEFAULT_DAYS));
  };
  let invalid = |message: &str| HttpError::bad_request("EXPIRY_INVALID", message);
  let duration = token::expiry_duration(value)
    .map_err(invalid)?
    .ok_or_else(|| {
      invalid(&format!(
        "{kind} tokens always expire. Choose a number of hours or days."
      ))
    })?;
  if duration > Duration::days(RUNNER_TOKEN_MAX_DAYS) {
    return Err(invalid(&format!(
      "{kind} tokens last at most {RUNNER_TOKEN_MAX_DAYS} days."
    )));
  }
  Ok(duration)
}

pub async fn create(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
  request: CreateTokenRequest,
) -> Result<CreatedTokenResponse, HttpError> {
  let (admin_id, email) = require_person(identity)?;
  if request.role != "runner" {
    return Err(HttpError::validation(std::collections::BTreeMap::from([(
      TOKEN_SCOPE_INVALID.into(),
      "Only the runner role is supported by this token endpoint.".into(),
    )])));
  }
  // Same rule as project and environment names.
  let name = request.name.trim();
  common::validate_slug(name, "TOKEN_NAME_INVALID", "Token name")?;
  let env = authorize(state, identity, id, Level::Manage).await?;
  // A runner token reads every secret in the environment, so a stolen CLI
  // session alone can't mint one.
  require_recent_auth(identity)?;
  let now = Utc::now();
  let expires_at = Some((now + token_lifetime(request.expires_in.as_deref(), "Runner")?).stamp());
  let token_id = token::public_id(RUNNER_TOKEN_ID_PREFIX);
  let raw = token::generate(RUNNER_TOKEN_PREFIX).map_err(|_| HttpError::internal())?;
  let now = now.stamp();
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let result = sqlx::query(
    "INSERT INTO runner_tokens(id, environment_id, name, token_hash, created_by, created_at, expires_at) VALUES($1, $2, $3, $4, $5, $6, $7)",
  )
  .bind(&token_id)
  .bind(id)
  .bind(name)
  .bind(token::hash(&raw))
  .bind(admin_id)
  .bind(&now)
  .bind(&expires_at)
  .execute(&mut *tx)
  .await;
  if let Err(error) = result {
    if error.to_string().contains("UNIQUE") {
      return Err(HttpError::conflict(
        "TOKEN_ALREADY_EXISTS",
        "A token with this name already exists in the environment.",
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
    Some(&env.project_id),
    Some(id),
    Some("token"),
    Some(&token_id),
    serde_json::json!({"name":name}),
  )
  .await?;
  tx.commit().await?;
  Ok(CreatedTokenResponse {
    token: TokenMetadata {
      id: token_id,
      environment_id: id.into(),
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
) -> Result<RevokedTokenMetadata, HttpError> {
  if repository::is_workspace_token_id(id) {
    let token = super::workspace::revoke(state, identity, id).await?;
    return Ok(token.into());
  }
  let (admin_id, email) = require_person(identity)?;
  let token = repository::find(state.db.pool(), id)
    .await?
    .ok_or_else(|| HttpError::not_found("TOKEN_NOT_FOUND", "The requested token was not found."))?;
  let env = authorize(state, identity, &token.environment_id, Level::Manage)
    .await
    .map_err(|error| {
      // A token in an environment the caller cannot see does not exist
      // for them either.
      if error.status == axum::http::StatusCode::NOT_FOUND {
        HttpError::not_found("TOKEN_NOT_FOUND", "The requested token was not found.")
      } else {
        error
      }
    })?;
  if token.revoked_at.is_some() {
    return Err(HttpError::conflict(
      "TOKEN_REVOKED",
      "The token has already been revoked.",
    ));
  }
  let now = Utc::now().stamp();
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let updated =
    sqlx::query("UPDATE runner_tokens SET revoked_at=$1 WHERE id=$2 AND revoked_at IS NULL")
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
    Some(&env.project_id),
    Some(&env.id),
    Some("token"),
    Some(id),
    serde_json::json!({"name":token.name}),
  )
  .await?;
  tx.commit().await?;
  repository::find(state.db.pool(), id)
    .await?
    .ok_or_else(HttpError::internal)
    .map(Into::into)
}
