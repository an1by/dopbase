use super::model::TokenMetadata;
use sqlx::SqlitePool;
pub async fn list(
  pool: &SqlitePool,
  id: &str,
) -> Result<Vec<TokenMetadata>, sqlx::Error> {
  sqlx::query_as("SELECT id,environment_id,name,created_at,expires_at,last_used_at,revoked_at FROM runner_tokens WHERE environment_id=$1 ORDER BY name").bind(id).fetch_all(pool).await
}
pub async fn find(
  pool: &SqlitePool,
  id: &str,
) -> Result<Option<TokenMetadata>, sqlx::Error> {
  sqlx::query_as("SELECT id,environment_id,name,created_at,expires_at,last_used_at,revoked_at FROM runner_tokens WHERE id=$1").bind(id).fetch_optional(pool).await
}

use super::model::WorkspaceTokenMetadata;
use crate::constants::tokens::WORKSPACE_TOKEN_ID_PREFIX;

pub async fn list_workspace(
  pool: &SqlitePool,
  workspace_id: &str,
) -> Result<Vec<WorkspaceTokenMetadata>, sqlx::Error> {
  sqlx::query_as(
    "SELECT id, workspace_id, name, created_at, expires_at, last_used_at, revoked_at FROM workspace_tokens WHERE workspace_id=$1 ORDER BY name",
  )
  .bind(workspace_id)
  .fetch_all(pool)
  .await
}

pub async fn find_workspace(
  pool: &SqlitePool,
  id: &str,
) -> Result<Option<WorkspaceTokenMetadata>, sqlx::Error> {
  sqlx::query_as(
    "SELECT id, workspace_id, name, created_at, expires_at, last_used_at, revoked_at FROM workspace_tokens WHERE id=$1",
  )
  .bind(id)
  .fetch_optional(pool)
  .await
}

pub fn is_workspace_token_id(id: &str) -> bool {
  id.starts_with(WORKSPACE_TOKEN_ID_PREFIX)
}
