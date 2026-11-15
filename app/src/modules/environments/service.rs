use super::{model::*, repository};
use crate::modules::common;
use crate::utils::time::Stamp;
use crate::{
  constants::errors::{ENVIRONMENT_NAME_INVALID, TOKEN_SCOPE_INVALID},
  extractors::require_person,
  http::HttpError,
  models::{AffectedCounts, AuthIdentity},
  services::{
    access::{Reach, Refusal, Resource},
    authx::Level,
  },
  state::AppState,
  utils::generator,
};
use chrono::Utc;

fn unique(error: sqlx::Error) -> HttpError {
  if error.to_string().contains("UNIQUE") {
    HttpError::conflict(
      "ENVIRONMENT_ALREADY_EXISTS",
      "An environment with this name already exists in the project.",
    )
  } else {
    HttpError::from(error)
  }
}

pub(crate) async fn insert_generated(
  tx: &mut sqlx::SqliteConnection,
  project_id: &str,
  name: &str,
  protected: bool,
  now: &str,
) -> Result<String, HttpError> {
  const MAX_ATTEMPTS: usize = 5;
  for _ in 0..MAX_ATTEMPTS {
    let id = generator::environment_id().map_err(|error| {
      tracing::error!(%error, "failed to generate environment id");
      HttpError::internal()
    })?;
    if repository::insert(tx, &id, project_id, name, protected, now)
      .await
      .map_err(unique)?
    {
      return Ok(id);
    }
  }
  tracing::error!(
    attempts = MAX_ATTEMPTS,
    "environment id generation collided repeatedly"
  );
  Err(HttpError::internal())
}

fn not_found() -> HttpError {
  Refusal::Hidden.into_http(Resource::Environment)
}

/// The environment row with the caller's level on it, when that reaches
/// `needed`. An environment the caller can't see at all is reported as
/// missing, so its existence doesn't leak.
fn check(
  mut environment: EnvironmentResponse,
  reach: &Reach,
  needed: Level,
) -> Result<EnvironmentResponse, HttpError> {
  environment.level = reach
    .require_environment(&environment.id, needed)
    .map_err(|refusal| refusal.into_http(Resource::Environment))?;
  Ok(environment)
}

/// The caller's reach over every project, on a connection of its own.
pub(crate) async fn reach(
  state: &AppState,
  identity: &AuthIdentity,
) -> Result<Reach, HttpError> {
  let mut conn = state.db.pool().acquire().await?;
  Ok(Reach::load(&mut conn, identity).await?)
}

/// The caller's reach over one environment's project, on a connection of
/// its own. Enough to judge that environment, without reading every
/// project and environment on each request.
async fn reach_for(
  state: &AppState,
  identity: &AuthIdentity,
  environment: &EnvironmentResponse,
) -> Result<Reach, HttpError> {
  let mut conn = state.db.pool().acquire().await?;
  Ok(Reach::load_project(&mut conn, identity, &environment.project_id).await?)
}

/// The environment, when the caller's level on it is at least `needed`.
pub async fn authorize(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
  needed: Level,
) -> Result<EnvironmentResponse, HttpError> {
  let environment = show(state, id).await?;
  let reach = reach_for(state, identity, &environment).await?;
  check(environment, &reach, needed)
}

/// Like [`authorize`], on the caller's write transaction, so a grant
/// revoked a moment ago is seen. The [`Reach`] it returns knows only this
/// environment's project; anything else reads as hidden.
pub(crate) async fn authorize_in(
  conn: &mut sqlx::SqliteConnection,
  identity: &AuthIdentity,
  id: &str,
  needed: Level,
) -> Result<(EnvironmentResponse, Reach), HttpError> {
  let environment = repository::find_id(&mut *conn, id)
    .await?
    .ok_or_else(not_found)?;
  let reach = Reach::load_project(conn, identity, &environment.project_id).await?;
  let environment = check(environment, &reach, needed)?;
  Ok((environment, reach))
}

/// The environment for a response: checked like [`authorize`] at
/// `Metadata`, with its secret count filled in.
pub async fn detail(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
) -> Result<EnvironmentResponse, HttpError> {
  let environment = authorize(state, identity, id, Level::Metadata).await?;
  counted(state, environment).await
}

async fn counted(
  state: &AppState,
  mut environment: EnvironmentResponse,
) -> Result<EnvironmentResponse, HttpError> {
  environment.secret_count = repository::secret_count(state.db.pool(), &environment.id).await?;
  Ok(environment)
}

pub async fn list(
  state: &AppState,
  identity: &AuthIdentity,
  project: Option<&str>,
) -> Result<Vec<EnvironmentResponse>, HttpError> {
  crate::extractors::require_metadata_access(identity)?;
  let reach = reach(state, identity).await?;
  Ok(
    repository::list(state.db.pool(), project)
      .await?
      .into_iter()
      .filter_map(|environment| check(environment, &reach, Level::Metadata).ok())
      .collect(),
  )
}
/// The environment without any access check.
pub(crate) async fn show(
  state: &AppState,
  id: &str,
) -> Result<EnvironmentResponse, HttpError> {
  repository::find_id(state.db.pool(), id)
    .await?
    .ok_or_else(not_found)
}
/// The id a reference names, without any access check.
pub(crate) async fn resolve_id(
  state: &AppState,
  reference: &str,
) -> Result<Option<String>, HttpError> {
  Ok(
    repository::resolve(state.db.pool(), reference)
      .await?
      .map(|environment| environment.id),
  )
}
/// The refusal for a runner that names another environment. It repeats the
/// reference only when it has no control characters, since the message
/// often lands in CI logs and a newline could fake another error line.
pub(crate) fn scope_refused(reference: &str) -> HttpError {
  let message = if reference.chars().any(char::is_control) {
    "The runner token cannot access this environment.".to_owned()
  } else {
    format!("The runner token cannot access {reference}.")
  };
  HttpError::forbidden(TOKEN_SCOPE_INVALID, &message)
}
pub async fn resolve(
  state: &AppState,
  identity: &AuthIdentity,
  reference: &str,
) -> Result<EnvironmentResponse, HttpError> {
  let environment = repository::resolve(state.db.pool(), reference).await?;
  // A runner gets one answer for a missing reference and another
  // environment's, so the refusal can't be used to find which ones exist.
  if let AuthIdentity::Runner { environment_id, .. } = identity
    && environment.as_ref().map(|environment| &environment.id) != Some(environment_id)
  {
    return Err(scope_refused(reference));
  }
  let environment = environment.ok_or_else(not_found)?;
  let reach = reach_for(state, identity, &environment).await?;
  let environment = check(environment, &reach, Level::Metadata)?;
  counted(state, environment).await
}
pub async fn create(
  state: &AppState,
  identity: &AuthIdentity,
  project_ref: &str,
  request: CreateEnvironmentRequest,
) -> Result<EnvironmentResponse, HttpError> {
  common::validate_slug(&request.name, ENVIRONMENT_NAME_INVALID, "Environment name")?;
  let (admin_id, email) = require_person(identity)?;
  let project = crate::modules::projects::service::authorize(
    state,
    identity,
    project_ref,
    Level::ProjectManager,
  )
  .await?;
  let now = Utc::now().stamp();
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  // Protected from the first row, so no grant ever sees it unprotected.
  let id = insert_generated(&mut tx, &project.id, &request.name, request.protected, &now).await?;
  common::audit(
    &mut tx,
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::EnvironmentCreated,
    Some(&project.id),
    Some(&id),
    Some("environment"),
    Some(&id),
    serde_json::json!({"name":request.name,"protected":request.protected}),
  )
  .await?;
  tx.commit().await?;
  detail(state, identity, &id).await
}
pub async fn update(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
  request: UpdateEnvironmentRequest,
) -> Result<EnvironmentResponse, HttpError> {
  if let Some(name) = &request.name {
    common::validate_slug(name, ENVIRONMENT_NAME_INVALID, "Environment name")?;
  }
  let (admin_id, email) = require_person(identity)?;
  // The check, the write and the answer share one transaction, so a grant
  // changed meanwhile is seen and the reply matches what was committed.
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let (environment, _) = authorize_in(&mut tx, identity, id, Level::Manage).await?;
  let name = request.name.as_deref().unwrap_or(&environment.name);
  let protected = request.protected.unwrap_or(environment.protected);
  let updated =
    sqlx::query("UPDATE environments SET name=$1,protected=$2,updated_at=$3 WHERE id=$4")
      .bind(name)
      .bind(protected)
      .bind(Utc::now().stamp())
      .bind(id)
      .execute(&mut *tx)
      .await
      .map_err(unique)?;
  if updated.rows_affected() != 1 {
    return Err(not_found());
  }
  // Protecting stops grants inherited from the project. A caller whose
  // Manage came from the project would lose the environment the moment
  // this commits, so the change is refused and nothing is written.
  let after = Reach::load_project(&mut tx, identity, &environment.project_id).await?;
  let level = after.environment(id).unwrap_or(Level::None);
  if level == Level::None {
    return Err(HttpError::conflict(
      "ENVIRONMENT_PROTECT_LOCKOUT",
      "Protecting this environment would take away your own access to it. Ask a project manager to protect it.",
    ));
  }
  if name != environment.name {
    common::audit(
      &mut tx,
      identity.audit_actor_type(),
      Some(admin_id),
      Some(email),
      crate::services::events::Action::EnvironmentRenamed,
      Some(&environment.project_id),
      Some(id),
      Some("environment"),
      Some(id),
      serde_json::json!({"oldName":environment.name,"newName":name}),
    )
    .await?;
  }
  if protected != environment.protected {
    common::audit(
      &mut tx,
      identity.audit_actor_type(),
      Some(admin_id),
      Some(email),
      if protected {
        crate::services::events::Action::EnvironmentProtected
      } else {
        crate::services::events::Action::EnvironmentUnprotected
      },
      Some(&environment.project_id),
      Some(id),
      Some("environment"),
      Some(id),
      serde_json::json!({"name":name}),
    )
    .await?;
  }
  let mut response = repository::find_id(&mut *tx, id)
    .await?
    .ok_or_else(not_found)?;
  response.level = level;
  response.secret_count = repository::secret_count(&mut *tx, id).await?;
  tx.commit().await?;
  Ok(response)
}
pub async fn delete(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
) -> Result<DeleteEnvironmentResponse, HttpError> {
  let (admin_id, email) = require_person(identity)?;
  let environment = authorize(state, identity, id, Level::Manage).await?;
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let secrets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM secrets WHERE environment_id=$1")
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
  let tokens: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM runner_tokens WHERE environment_id=$1")
      .bind(id)
      .fetch_one(&mut *tx)
      .await?;
  let deleted = sqlx::query("DELETE FROM environments WHERE id=$1")
    .bind(id)
    .execute(&mut *tx)
    .await?;
  if deleted.rows_affected() != 1 {
    return Err(not_found());
  }
  common::audit(
    &mut tx,
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::EnvironmentDeleted,
    Some(&environment.project_id),
    Some(id),
    Some("environment"),
    Some(id),
    serde_json::json!({"name":environment.name,"secrets":secrets,"tokens":tokens}),
  )
  .await?;
  tx.commit().await?;
  Ok(DeleteEnvironmentResponse {
    affected: AffectedCounts {
      projects: 0,
      environments: 1,
      secrets: secrets as u64,
      tokens: tokens as u64,
    },
  })
}
