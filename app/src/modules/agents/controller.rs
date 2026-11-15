use super::{model::*, service};
use crate::{
  http::{HttpResponse, HttpResponseFormat},
  models::AuthIdentity,
  modules::{
    accounts::Kind,
    grants::{self, model::UserAccessResponse},
    tokens::personal::{self, model::*},
    users::model::UserStatus,
  },
  state::AppState,
};
use axum::{
  extract::{Path, State},
  http::HeaderMap,
};

/// List AI agents
///
/// Return the AI agents you may see, ordered by role and name: every agent
/// with agents.view_all, and the agents you own with agents.view. Requires
/// an Admin UI session.
#[utoipa::path(
  get,
  path = crate::constants::api::agents::COLLECTION,
  tag = "agents",
  security(("cookieAuth" = [])),
  responses(
    (status = 200, description = "AI agents fetched", body = inline(HttpResponseFormat<Vec<AgentResponse>>)),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "An Admin UI session with users.view or an agents capability is required", body = crate::http::ErrorBody),
  ),
)]
pub async fn list(
  State(state): State<AppState>,
  identity: AuthIdentity,
) -> Result<HttpResponse<Vec<AgentResponse>>, crate::http::HttpError> {
  Ok(HttpResponse::ok(
    service::list(&state, &identity).await?,
    "AGENTS_FETCHED",
  ))
}

/// Get an AI agent
///
/// Return one AI agent you may see. Requires an Admin UI session.
#[utoipa::path(
  get,
  path = crate::constants::api::agents::ITEM,
  tag = "agents",
  security(("cookieAuth" = [])),
  params(("id" = String, Path, description = "Agent ID")),
  responses(
    (status = 200, description = "AI agent fetched", body = inline(HttpResponseFormat<AgentResponse>)),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "An Admin UI session with an agents capability is required", body = crate::http::ErrorBody),
    (status = 404, description = "The AI agent was not found", body = crate::http::ErrorBody),
  ),
)]
pub async fn get(
  State(state): State<AppState>,
  identity: AuthIdentity,
  Path(id): Path<String>,
) -> Result<HttpResponse<AgentResponse>, crate::http::HttpError> {
  Ok(HttpResponse::ok(
    service::get(&state, &identity, &id).await?,
    "AGENT_FETCHED",
  ))
}

/// Add an AI agent
///
/// Add an AI agent, which needs agents.view. Whoever adds it owns it. It
/// has no password, signs in with personal tokens only, and starts with no
/// access. Requires an Admin UI session with recent authentication and the
/// CSRF header.
#[utoipa::path(
  post,
  path = crate::constants::api::agents::COLLECTION,
  tag = "agents",
  security(("cookieAuth" = [])),
  request_body = CreateAgentRequest,
  responses(
    (status = 201, description = "AI agent added", body = inline(HttpResponseFormat<AgentResponse>)),
    (status = 400, description = "The role doesn't sign in with tokens only, or `ownerId` was sent", body = crate::http::ErrorBody),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "agents.view, recent authentication and the CSRF header are required", body = crate::http::ErrorBody),
    (status = 409, description = "An AI agent with this name already exists", body = crate::http::ErrorBody),
    (status = 422, description = "The name is invalid", body = crate::http::ErrorBody),
  ),
)]
pub async fn create(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  axum::Json(request): axum::Json<CreateAgentRequest>,
) -> Result<HttpResponse<AgentResponse>, crate::http::HttpError> {
  Ok(HttpResponse::created(
    service::create(&state, &identity, &headers, request).await?,
    "AGENT_CREATED",
  ))
}

/// Change an AI agent
///
/// Rename an AI agent, which its owner or agents.manage may do, or change
/// its role or owner, which needs agents.manage. A new owner revokes its
/// tokens. Requires an Admin UI session with recent authentication and the
/// CSRF header.
#[utoipa::path(
  patch,
  path = crate::constants::api::agents::ITEM,
  tag = "agents",
  security(("cookieAuth" = [])),
  params(("id" = String, Path, description = "Agent ID")),
  request_body = UpdateAgentRequest,
  responses(
    (status = 200, description = "AI agent changed", body = inline(HttpResponseFormat<AgentResponse>)),
    (status = 400, description = "The role or owner is invalid", body = crate::http::ErrorBody),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "The caller can't change this agent", body = crate::http::ErrorBody),
    (status = 404, description = "The AI agent was not found", body = crate::http::ErrorBody),
    (status = 409, description = "An AI agent with this name already exists", body = crate::http::ErrorBody),
    (status = 422, description = "The name is invalid", body = crate::http::ErrorBody),
  ),
)]
pub async fn update(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  Path(id): Path<String>,
  axum::Json(request): axum::Json<UpdateAgentRequest>,
) -> Result<HttpResponse<AgentResponse>, crate::http::HttpError> {
  Ok(HttpResponse::ok(
    service::update(&state, &identity, &headers, &id, request).await?,
    "AGENT_UPDATED",
  ))
}

/// Delete an AI agent
///
/// Delete an AI agent with its grants, group memberships and tokens. Its
/// owner or agents.manage may. Audit events stay. Requires an Admin UI
/// session with recent authentication and the CSRF header.
#[utoipa::path(
  delete,
  path = crate::constants::api::agents::ITEM,
  tag = "agents",
  security(("cookieAuth" = [])),
  params(("id" = String, Path, description = "Agent ID")),
  responses(
    (status = 200, description = "AI agent deleted", body = inline(HttpResponseFormat<serde_json::Value>)),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "The caller can't delete this agent", body = crate::http::ErrorBody),
    (status = 404, description = "The AI agent was not found", body = crate::http::ErrorBody),
  ),
)]
pub async fn delete(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  Path(id): Path<String>,
) -> Result<HttpResponse<serde_json::Value>, crate::http::HttpError> {
  service::delete(&state, &identity, &headers, &id).await?;
  Ok(HttpResponse::ok(serde_json::json!({}), "AGENT_DELETED"))
}

/// Disable an AI agent
///
/// Its tokens are refused until it is enabled again. Its owner or
/// agents.manage may. Requires an Admin UI session with recent
/// authentication and the CSRF header.
#[utoipa::path(
  post,
  path = crate::constants::api::agents::DISABLE,
  tag = "agents",
  security(("cookieAuth" = [])),
  params(("id" = String, Path, description = "Agent ID")),
  responses(
    (status = 200, description = "AI agent disabled", body = inline(HttpResponseFormat<AgentResponse>)),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "The caller can't disable this agent", body = crate::http::ErrorBody),
    (status = 404, description = "The AI agent was not found", body = crate::http::ErrorBody),
  ),
)]
pub async fn disable(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  Path(id): Path<String>,
) -> Result<HttpResponse<AgentResponse>, crate::http::HttpError> {
  Ok(HttpResponse::ok(
    service::set_status(&state, &identity, &headers, &id, UserStatus::Disabled).await?,
    "AGENT_DISABLED",
  ))
}

/// Enable an AI agent
///
/// An owner turns their agent back on only when they were the one who
/// turned it off; otherwise it needs agents.manage. Requires an Admin UI
/// session with recent authentication and the CSRF header.
#[utoipa::path(
  post,
  path = crate::constants::api::agents::ENABLE,
  tag = "agents",
  security(("cookieAuth" = [])),
  params(("id" = String, Path, description = "Agent ID")),
  responses(
    (status = 200, description = "AI agent enabled", body = inline(HttpResponseFormat<AgentResponse>)),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "The caller can't enable this agent", body = crate::http::ErrorBody),
    (status = 404, description = "The AI agent was not found", body = crate::http::ErrorBody),
  ),
)]
pub async fn enable(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  Path(id): Path<String>,
) -> Result<HttpResponse<AgentResponse>, crate::http::HttpError> {
  Ok(HttpResponse::ok(
    service::set_status(&state, &identity, &headers, &id, UserStatus::Active).await?,
    "AGENT_ENABLED",
  ))
}

/// AI agent access
///
/// List an AI agent's groups and the grants that reach it, capped by its
/// owner. Needs agents.view_all, or agents.view when you own it.
#[utoipa::path(
  get,
  path = crate::constants::api::agents::ACCESS,
  tag = "agents",
  security(("bearerAuth" = []), ("cookieAuth" = [])),
  params(("id" = String, Path, description = "Agent ID")),
  responses(
    (status = 200, description = "AI agent access fetched", body = inline(HttpResponseFormat<UserAccessResponse>)),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "agents.view_all, or owning the agent, is required", body = crate::http::ErrorBody),
    (status = 404, description = "The AI agent was not found", body = crate::http::ErrorBody),
  ),
)]
pub async fn access(
  State(state): State<AppState>,
  identity: AuthIdentity,
  Path(id): Path<String>,
) -> Result<HttpResponse<UserAccessResponse>, crate::http::HttpError> {
  Ok(HttpResponse::ok(
    grants::service::user_access(&state, &identity, &id, Kind::Agent).await?,
    "AGENT_ACCESS_FETCHED",
  ))
}

/// List an AI agent's tokens
///
/// Needs agents.view_all, or agents.view when you own the agent.
#[utoipa::path(
  get,
  path = crate::constants::api::agents::TOKENS,
  tag = "agents",
  security(("bearerAuth" = []), ("cookieAuth" = [])),
  params(("id" = String, Path, description = "Agent ID")),
  responses(
    (status = 200, description = "Tokens fetched", body = inline(HttpResponseFormat<Vec<PersonalTokenResponse>>)),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "agents.view_all, or owning the agent, is required", body = crate::http::ErrorBody),
    (status = 404, description = "The AI agent was not found", body = crate::http::ErrorBody),
  ),
)]
pub async fn tokens(
  State(state): State<AppState>,
  identity: AuthIdentity,
  Path(id): Path<String>,
) -> Result<HttpResponse<Vec<PersonalTokenResponse>>, crate::http::HttpError> {
  Ok(HttpResponse::ok(
    personal::service::list(&state, &identity, &id, Kind::Agent).await?,
    "PERSONAL_TOKENS_FETCHED",
  ))
}

/// Create an AI agent token
///
/// For an agent you own (agents.view), or anyone's with agents.manage when
/// its access is within yours. With `replaceExisting`, the agent's other
/// valid tokens are revoked in the same step. Browser sessions need recent
/// authentication and the CSRF header.
#[utoipa::path(
  post,
  path = crate::constants::api::agents::TOKENS,
  tag = "agents",
  security(("bearerAuth" = []), ("cookieAuth" = [])),
  params(("id" = String, Path, description = "Agent ID")),
  request_body = CreatePersonalTokenRequest,
  responses(
    (status = 201, description = "Token created", body = inline(HttpResponseFormat<CreatedPersonalTokenResponse>)),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "The caller can't create tokens for this agent", body = crate::http::ErrorBody),
    (status = 404, description = "The AI agent, project, or environment was not found", body = crate::http::ErrorBody),
    (status = 409, description = "A token with this name already exists", body = crate::http::ErrorBody),
    (status = 422, description = "The name, scope, level, or expiry is invalid", body = crate::http::ErrorBody),
  ),
)]
pub async fn create_token(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  Path(id): Path<String>,
  axum::Json(request): axum::Json<CreatePersonalTokenRequest>,
) -> Result<HttpResponse<CreatedPersonalTokenResponse>, crate::http::HttpError> {
  Ok(HttpResponse::created(
    personal::service::create(&state, &identity, &headers, &id, request, Kind::Agent).await?,
    "PERSONAL_TOKEN_CREATED",
  ))
}

/// Revoke an AI agent token
///
/// Its owner (agents.view) or agents.manage may, when the agent is within
/// their access.
#[utoipa::path(
  post,
  path = crate::constants::api::agents::TOKEN_REVOKE,
  tag = "agents",
  security(("bearerAuth" = []), ("cookieAuth" = [])),
  params(
    ("id" = String, Path, description = "Agent ID"),
    ("token_id" = String, Path, description = "Token ID"),
  ),
  responses(
    (status = 200, description = "Token revoked", body = inline(HttpResponseFormat<PersonalTokenResponse>)),
    (status = 401, description = "Authentication is required", body = crate::http::ErrorBody),
    (status = 403, description = "The caller can't revoke this token", body = crate::http::ErrorBody),
    (status = 404, description = "The AI agent or token was not found", body = crate::http::ErrorBody),
    (status = 409, description = "The token was already revoked", body = crate::http::ErrorBody),
  ),
)]
pub async fn revoke_token(
  State(state): State<AppState>,
  headers: HeaderMap,
  identity: AuthIdentity,
  Path((id, token_id)): Path<(String, String)>,
) -> Result<HttpResponse<PersonalTokenResponse>, crate::http::HttpError> {
  Ok(HttpResponse::ok(
    personal::service::revoke(&state, &identity, &headers, &id, &token_id, Kind::Agent).await?,
    "PERSONAL_TOKEN_REVOKED",
  ))
}
