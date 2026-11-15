use crate::{
  http::HttpError,
  modules::{
    grants::model::GroupRef,
    users::{model::UserStatus, service::AccountDetails},
  },
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// An AI agent: an account that signs in with personal tokens only and has
/// a person who answers for it.
#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentResponse {
  /// Agent identifier: `agt_`, or `usr_` for an agent restored from 0.1.x.
  pub id: String,
  /// Letters, digits, dots, dashes, and underscores, such as `review-bot`.
  pub name: String,
  /// The agent's role, which signs in with tokens only.
  pub role_id: String,
  pub role_name: String,
  /// The person who answers for the agent. It never reaches more than they
  /// do.
  pub owner_id: String,
  /// The owner's email, so the owner shows without listing people.
  pub owner_email: Option<String>,
  /// `active` or `disabled`.
  pub status: UserStatus,
  /// The groups the agent belongs to, by name.
  pub groups: Vec<GroupRef>,
  /// ISO 8601 creation timestamp.
  pub created_at: String,
  /// ISO 8601 last update timestamp.
  pub updated_at: String,
}

impl TryFrom<AccountDetails> for AgentResponse {
  type Error = HttpError;

  /// Every agent has a role and an owner, so one without them is a bug,
  /// not an empty field.
  fn try_from(details: AccountDetails) -> Result<Self, HttpError> {
    let AccountDetails { row, groups } = details;
    if !row.agent {
      return Err(HttpError::internal());
    }
    Ok(Self {
      status: UserStatus::parse(&row.status).ok_or_else(HttpError::internal)?,
      role_id: row.role_id.ok_or_else(HttpError::internal)?,
      owner_id: row.owner_id.ok_or_else(HttpError::internal)?,
      id: row.id,
      name: row.label,
      role_name: row.role_name,
      owner_email: row.owner_email,
      groups,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })
  }
}

/// Request to add an AI agent. Whoever adds it becomes its owner. Unknown
/// fields are refused, so a `password` or `email` meant for a person
/// fails loudly instead of being dropped.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAgentRequest {
  /// 2 to 64 letters, digits, dots, dashes, or underscores, such as
  /// `review-bot`.
  pub name: String,
  /// A role from `GET /api/v1/roles` that signs in with tokens only.
  /// Defaults to the built-in AI agent role.
  #[serde(default)]
  pub role_id: Option<String>,
  /// Refused here: a new AI agent belongs to whoever creates it. Hand it to
  /// someone else afterwards with `ownerId` on `PATCH /api/v1/agents/{id}`.
  #[serde(default)]
  pub owner_id: Option<String>,
}

/// Request to rename an AI agent, change its role, or hand it to someone
/// else. Unknown fields, such as a `password`, are refused.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAgentRequest {
  #[serde(default)]
  pub name: Option<String>,
  /// Another role that signs in with tokens only. Needs agents.manage.
  #[serde(default)]
  pub role_id: Option<String>,
  /// A new owner: an active person who can run AI agents. Needs
  /// agents.manage, and revokes the agent's tokens.
  #[serde(default)]
  pub owner_id: Option<String>,
}
