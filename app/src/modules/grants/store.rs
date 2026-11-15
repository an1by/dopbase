//! The grant store: the only code that writes grants. Granting from the
//! Users or Access pages, the all-projects grant a role gives, and the
//! project-manager grant a project's creator gets all go through here, so
//! every change records a `grant.set` or `grant.removed` event in the
//! caller's transaction. Reads are in [`super::repository`].

use sqlx::SqliteConnection;

use super::{
  model::{GrantResponse, PrincipalType, ScopeType},
  repository::{self, NewGrant},
};
use crate::{
  constants::tokens::GRANT_ID_PREFIX, http::HttpError, modules::common, services::authx::Level,
  services::token,
};

/// Who is changing a grant, as the audit record names them.
#[derive(Clone, Copy, Debug)]
pub struct Actor<'a> {
  pub actor_type: &'a str,
  pub id: &'a str,
  pub label: &'a str,
}

/// A grant to set: who gets what level where.
pub struct Change<'a> {
  pub principal_type: PrincipalType,
  pub principal_id: &'a str,
  /// The email or group name, for the audit record.
  pub principal_label: &'a str,
  pub scope_type: ScopeType,
  /// The project id or environment id; empty for all projects.
  pub scope_id: &'a str,
  /// The project the scope is in, for the audit record's filter columns.
  pub project_id: Option<&'a str>,
  pub level: Level,
}

/// Sets a grant, or changes the level of the one already on that scope,
/// and records `grant.set` with the level before. Returns the grant's id.
pub async fn set(
  conn: &mut SqliteConnection,
  actor: Actor<'_>,
  change: Change<'_>,
  now: &str,
) -> Result<String, HttpError> {
  let previous = repository::existing_level(
    &mut *conn,
    change.principal_type,
    change.principal_id,
    change.scope_type,
    change.scope_id,
  )
  .await?;
  let id = repository::upsert(
    &mut *conn,
    NewGrant {
      id: &token::public_id(GRANT_ID_PREFIX),
      principal_type: change.principal_type,
      principal_id: change.principal_id,
      scope_type: change.scope_type,
      scope_id: change.scope_id,
      level: change.level,
      granted_by: actor.id,
      now,
    },
  )
  .await?;
  let environment_id = (change.scope_type == ScopeType::Environment).then_some(change.scope_id);
  common::audit(
    &mut *conn,
    actor.actor_type,
    Some(actor.id),
    Some(actor.label),
    crate::services::events::Action::GrantSet,
    change.project_id,
    environment_id,
    Some("grant"),
    Some(&id),
    serde_json::json!({
      "principalType": change.principal_type.as_str(),
      "principalId": change.principal_id,
      "principal": change.principal_label,
      "scopeType": change.scope_type.as_str(),
      "scopeId": change.scope_id,
      "level": change.level.as_str(),
      "previousLevel": previous,
    }),
  )
  .await?;
  Ok(id)
}

/// Removes a grant the caller already found and records `grant.removed`.
/// Returns false when it was gone already.
pub async fn remove(
  conn: &mut SqliteConnection,
  actor: Actor<'_>,
  grant: &GrantResponse,
) -> Result<bool, HttpError> {
  if !repository::delete(&mut *conn, &grant.id).await? {
    return Ok(false);
  }
  let project_id = (!grant.project_id.is_empty()).then_some(grant.project_id.as_str());
  let environment_id =
    (grant.scope_type == ScopeType::Environment).then_some(grant.scope_id.as_str());
  common::audit(
    &mut *conn,
    actor.actor_type,
    Some(actor.id),
    Some(actor.label),
    crate::services::events::Action::GrantRemoved,
    project_id,
    environment_id,
    Some("grant"),
    Some(&grant.id),
    serde_json::json!({
      "principalType": grant.principal_type.as_str(),
      "principalId": grant.principal_id,
      "principal": grant.principal_label,
      "scopeType": grant.scope_type.as_str(),
      "scopeId": grant.scope_id,
      "level": grant.level.as_str(),
    }),
  )
  .await?;
  Ok(true)
}

/// Gives an account the all-projects grant its role starts with, or takes
/// it away with `None`. Each change is recorded like any other grant.
pub async fn set_all_projects(
  conn: &mut SqliteConnection,
  actor: Actor<'_>,
  user_id: &str,
  user_label: &str,
  level: Option<Level>,
  now: &str,
) -> Result<(), HttpError> {
  let current: Option<String> =
    sqlx::query_scalar("SELECT id FROM grants WHERE account_id = $1 AND scope = 'all'")
      .bind(user_id)
      .fetch_optional(&mut *conn)
      .await?;
  match (current, level) {
    (Some(id), None) => {
      let grant = repository::find(&mut *conn, &id)
        .await?
        .ok_or_else(HttpError::internal)?;
      remove(conn, actor, &grant).await?;
    }
    (_, Some(level)) => {
      set(
        conn,
        actor,
        Change {
          principal_type: PrincipalType::User,
          principal_id: user_id,
          principal_label: user_label,
          scope_type: ScopeType::All,
          scope_id: "",
          project_id: None,
          level,
        },
        now,
      )
      .await?;
    }
    (None, None) => {}
  }
  Ok(())
}

/// Makes the creator of a new project its project manager.
pub async fn grant_creator(
  conn: &mut SqliteConnection,
  actor: Actor<'_>,
  project_id: &str,
  now: &str,
) -> Result<(), HttpError> {
  set(
    conn,
    actor,
    Change {
      principal_type: PrincipalType::User,
      principal_id: actor.id,
      principal_label: actor.label,
      scope_type: ScopeType::Project,
      scope_id: project_id,
      project_id: Some(project_id),
      level: Level::ProjectManager,
    },
    now,
  )
  .await
  .map(|_| ())
}
