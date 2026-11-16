use crate::{
  extractors::require_mutation,
  http::{HttpError, HttpResponse},
  models::AuthIdentity,
  state::AppState,
};
use axum::{
  Json, Router,
  extract::{Path, State},
  http::HeaderMap,
  routing::get,
};
use serde::{Deserialize, Serialize};
use utoipa::{OpenApi, ToSchema};

mod repository;
mod service;

#[derive(Clone, Debug, Serialize, sqlx::FromRow, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
  pub id: String,
  pub name: String,
  pub root_path: String,
  pub created_at: String,
  pub updated_at: String,
}

pub const DEFAULT_WORKSPACE_ROOT_PATH: &str = "/workspace";

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceInput {
  pub name: String,
  pub root_path: Option<String>,
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceInput {
  pub name: String,
  pub root_path: String,
}

pub fn validate_root(value: &str) -> Result<(), HttpError> {
  let path = value.replace('\\', "/");
  let absolute = path.starts_with('/')
    || (path.as_bytes().get(1) == Some(&b':')
      && path.as_bytes().get(2) == Some(&b'/')
      && path.as_bytes()[0].is_ascii_alphabetic());
  if !absolute
    || path.len() > 4096
    || path.chars().any(char::is_control)
    || path.split('/').any(|part| part == ".." || part == ".")
  {
    return Err(HttpError::bad_request(
      "WORKSPACE_PATH_INVALID",
      "Use an absolute root path without '.' or '..' components.",
    ));
  }
  Ok(())
}

pub fn validate_relative(value: &str) -> Result<(), HttpError> {
  if value == "." {
    return Ok(());
  }
  let path = value.replace('\\', "/");
  if path.is_empty()
    || path.len() > 4096
    || path.starts_with('/')
    || path.contains(':')
    || path.chars().any(char::is_control)
    || path
      .split('/')
      .any(|part| part.is_empty() || part == ".." || part == ".")
  {
    return Err(HttpError::bad_request(
      "PROJECT_PATH_INVALID",
      "Use a relative project directory inside the workspace, or '.' for its root.",
    ));
  }
  Ok(())
}

#[utoipa::path(get, path=crate::constants::api::workspaces::COLLECTION, tag="workspaces", responses((status=200, description="Workspaces fetched")), security(("bearerAuth"=[]), ("cookieAuth"=[])))]
pub async fn list(
  State(state): State<AppState>,
  identity: AuthIdentity,
) -> Result<HttpResponse<Vec<Workspace>>, HttpError> {
  Ok(HttpResponse::ok(
    service::list(&state, &identity).await?,
    "WORKSPACES_FETCHED",
  ))
}

#[utoipa::path(post, path=crate::constants::api::workspaces::COLLECTION, tag="workspaces", request_body=CreateWorkspaceInput, responses((status=201, description="Workspace created")), security(("bearerAuth"=[]), ("cookieAuth"=[])))]
pub async fn create(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  Json(input): Json<CreateWorkspaceInput>,
) -> Result<HttpResponse<Workspace>, HttpError> {
  require_mutation(&identity, &headers)?;
  Ok(HttpResponse::created(
    service::create(&state, &identity, input).await?,
    "WORKSPACE_CREATED",
  ))
}

#[utoipa::path(patch, path=crate::constants::api::workspaces::ITEM, tag="workspaces", request_body=UpdateWorkspaceInput, params(("id"=String, Path)), responses((status=200, description="Workspace updated")), security(("bearerAuth"=[]), ("cookieAuth"=[])))]
pub async fn update(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  Path(id): Path<String>,
  Json(input): Json<UpdateWorkspaceInput>,
) -> Result<HttpResponse<Workspace>, HttpError> {
  require_mutation(&identity, &headers)?;
  Ok(HttpResponse::ok(
    service::update(&state, &identity, &id, input).await?,
    "WORKSPACE_UPDATED",
  ))
}

#[utoipa::path(delete, path=crate::constants::api::workspaces::ITEM, tag="workspaces", params(("id"=String, Path)), responses((status=200, description="Empty workspace deleted")), security(("bearerAuth"=[]), ("cookieAuth"=[])))]
pub async fn delete(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  Path(id): Path<String>,
) -> Result<HttpResponse<serde_json::Value>, HttpError> {
  require_mutation(&identity, &headers)?;
  service::delete(&state, &identity, &id).await?;
  Ok(HttpResponse::ok(serde_json::json!({}), "WORKSPACE_DELETED"))
}

pub fn routes() -> Router<AppState> {
  Router::new()
    .route(
      crate::constants::api::workspaces::COLLECTION,
      get(list).post(create),
    )
    .route(
      crate::constants::api::workspaces::ITEM,
      axum::routing::patch(update).delete(delete),
    )
}

#[derive(OpenApi)]
#[openapi(paths(list,create,update,delete), components(schemas(Workspace,CreateWorkspaceInput,UpdateWorkspaceInput)), tags((name="workspaces")))]
struct WorkspaceApi;

pub fn openapi() -> utoipa::openapi::OpenApi {
  WorkspaceApi::openapi()
}
