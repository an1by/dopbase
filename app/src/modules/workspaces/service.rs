use super::{
  CreateWorkspaceInput, DEFAULT_WORKSPACE_ROOT_PATH, UpdateWorkspaceInput, Workspace, repository,
  validate_root,
};
use crate::{
  extractors::{require_capability, require_person},
  http::HttpError,
  models::AuthIdentity,
  modules::common,
  services::authx::Capability,
  state::AppState,
};

fn unique(error: sqlx::Error) -> HttpError {
  if error.to_string().contains("UNIQUE") {
    HttpError::conflict(
      "WORKSPACE_ALREADY_EXISTS",
      "A workspace with this name already exists.",
    )
  } else {
    error.into()
  }
}

pub async fn list(
  state: &AppState,
  identity: &AuthIdentity,
) -> Result<Vec<Workspace>, HttpError> {
  require_person(identity)?;
  Ok(repository::list(state.db.pool()).await?)
}

pub async fn create(
  state: &AppState,
  identity: &AuthIdentity,
  input: CreateWorkspaceInput,
) -> Result<Workspace, HttpError> {
  let (admin_id, email) = require_capability(identity, Capability::ProjectsCreate)?;
  common::validate_slug(&input.name, "WORKSPACE_NAME_INVALID", "Workspace name")?;
  let root_path = input
    .root_path
    .as_deref()
    .unwrap_or(DEFAULT_WORKSPACE_ROOT_PATH);
  validate_root(root_path)?;
  let id = crate::services::token::public_id("wsp_");
  let now = chrono::Utc::now().to_rfc3339();
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let row = repository::insert(&mut tx, &id, &input.name, root_path, &now)
    .await
    .map_err(unique)?;
  common::audit(
    &mut tx,
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::WorkspaceCreated,
    None,
    None,
    Some("workspace"),
    Some(&id),
    serde_json::json!({"name": input.name}),
  )
  .await?;
  tx.commit().await?;
  Ok(row)
}

pub async fn update(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
  input: UpdateWorkspaceInput,
) -> Result<Workspace, HttpError> {
  let (admin_id, email) = require_capability(identity, Capability::ProjectsCreate)?;
  common::validate_slug(&input.name, "WORKSPACE_NAME_INVALID", "Workspace name")?;
  validate_root(&input.root_path)?;
  let now = chrono::Utc::now().to_rfc3339();
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let row = repository::update(&mut tx, id, &input.name, &input.root_path, &now)
    .await
    .map_err(unique)?
    .ok_or_else(|| HttpError::not_found("WORKSPACE_NOT_FOUND", "Workspace not found."))?;
  common::audit(
    &mut tx,
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::WorkspaceUpdated,
    None,
    None,
    Some("workspace"),
    Some(id),
    serde_json::json!({"name": input.name}),
  )
  .await?;
  tx.commit().await?;
  Ok(row)
}

pub async fn delete(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
) -> Result<(), HttpError> {
  let (admin_id, email) = require_capability(identity, Capability::ProjectsCreate)?;
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  if repository::project_count(&mut tx, id).await? > 0 {
    return Err(HttpError::conflict(
      "WORKSPACE_NOT_EMPTY",
      "Move the workspace's projects before deleting it.",
    ));
  }
  if repository::delete(&mut tx, id).await? != 1 {
    return Err(HttpError::not_found(
      "WORKSPACE_NOT_FOUND",
      "Workspace not found.",
    ));
  }
  common::audit(
    &mut tx,
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::WorkspaceDeleted,
    None,
    None,
    Some("workspace"),
    Some(id),
    serde_json::json!({}),
  )
  .await?;
  tx.commit().await?;
  Ok(())
}
