//! AI agents. The rules for who may see and change an account are shared
//! with people, so this asks the users service with the agent kind and
//! shapes the answer as an agent.

use super::model::*;
use crate::{
  http::HttpError,
  models::{AdminRole, AuthIdentity},
  modules::{
    accounts::Kind,
    users::{
      model::UserStatus,
      service::{self as accounts, AccountChange, NewAccount},
    },
  },
  state::AppState,
};
use axum::http::HeaderMap;

pub async fn list(
  state: &AppState,
  identity: &AuthIdentity,
) -> Result<Vec<AgentResponse>, HttpError> {
  accounts::list_accounts(state, identity, Kind::Agent)
    .await?
    .into_iter()
    .map(AgentResponse::try_from)
    .collect()
}

pub async fn get(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
) -> Result<AgentResponse, HttpError> {
  accounts::get_account(state, identity, id, Kind::Agent)
    .await?
    .try_into()
}

pub async fn create(
  state: &AppState,
  identity: &AuthIdentity,
  headers: &HeaderMap,
  request: CreateAgentRequest,
) -> Result<AgentResponse, HttpError> {
  let role = request.role_id.is_none().then_some(AdminRole::AiAgent);
  let request = NewAccount {
    label: request.name,
    password: None,
    role_id: request.role_id,
    role,
    owner_id: request.owner_id,
  };
  accounts::create_account(state, identity, headers, request, Kind::Agent)
    .await?
    .try_into()
}

pub async fn update(
  state: &AppState,
  identity: &AuthIdentity,
  headers: &HeaderMap,
  id: &str,
  request: UpdateAgentRequest,
) -> Result<AgentResponse, HttpError> {
  let request = AccountChange {
    label: request.name,
    password: None,
    role: None,
    role_id: request.role_id,
    owner_id: request.owner_id,
  };
  accounts::update_account(state, identity, headers, id, request, Kind::Agent)
    .await?
    .try_into()
}

pub async fn delete(
  state: &AppState,
  identity: &AuthIdentity,
  headers: &HeaderMap,
  id: &str,
) -> Result<(), HttpError> {
  accounts::delete_account(state, identity, headers, id, Kind::Agent).await
}

pub async fn set_status(
  state: &AppState,
  identity: &AuthIdentity,
  headers: &HeaderMap,
  id: &str,
  status: UserStatus,
) -> Result<AgentResponse, HttpError> {
  accounts::set_account_status(state, identity, headers, id, status, Kind::Agent)
    .await?
    .try_into()
}
