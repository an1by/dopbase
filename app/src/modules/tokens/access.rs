use crate::{
  constants::errors::TOKEN_SCOPE_INVALID,
  http::HttpError,
  models::{AuthIdentity, RunnerScope},
};
use sqlx::SqlitePool;

pub async fn runner_may_access_environment(
  pool: &SqlitePool,
  identity: &AuthIdentity,
  environment_id: &str,
) -> Result<(), HttpError> {
  let AuthIdentity::Runner { scope, .. } = identity else {
    return Ok(());
  };
  let allowed = match scope {
    RunnerScope::Environment(id) => id == environment_id,
    RunnerScope::Workspace(workspace_id) => sqlx::query_scalar(
      "SELECT EXISTS(
           SELECT 1 FROM environments e
           INNER JOIN project_locations l ON l.project_id = e.project_id
           WHERE e.id = $1 AND l.workspace_id = $2)",
    )
    .bind(environment_id)
    .bind(workspace_id)
    .fetch_one(pool)
    .await
    .map_err(HttpError::from)?,
  };
  if allowed {
    Ok(())
  } else {
    Err(HttpError::forbidden(
      TOKEN_SCOPE_INVALID,
      "The runner token cannot access this environment.",
    ))
  }
}
