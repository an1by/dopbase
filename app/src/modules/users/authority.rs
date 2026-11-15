//! Account authority: may this caller act on that account? The rules depend
//! on how the caller relates to the account (it's them, they own it as an
//! AI agent, or it's someone else) and on what kind of account it is.
//! Grants, group membership and personal tokens all ask here, so a rule
//! can't hold in one place and be missing in another.

use std::collections::BTreeMap;

use sqlx::SqliteConnection;

use crate::{
  extractors::require_capability,
  http::HttpError,
  models::AuthIdentity,
  services::authx::{self, Capability, Level},
};

/// Who the caller is to the account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relation {
  Myself,
  /// The caller answers for this AI agent.
  Owner,
  Other,
}

/// What the rules need to know about an account, loaded once.
#[derive(Clone, Debug)]
pub struct Account {
  pub id: String,
  /// A person's email or an AI agent's name.
  pub label: String,
  pub is_root: bool,
  /// An AI agent, stored in `agents`.
  pub agent: bool,
  pub owner_id: Option<String>,
  /// The deepest level its role allows.
  pub ceiling: Level,
}

/// label, is_root, role_id, agent, owner_id
type AccountRow = (String, bool, Option<String>, bool, Option<String>);

impl Account {
  pub async fn load(
    conn: &mut SqliteConnection,
    id: &str,
  ) -> Result<Option<Self>, sqlx::Error> {
    let row: Option<AccountRow> = sqlx::query_as(
      "SELECT label, is_root, role_id, kind = 'agent', owner_id FROM account_profiles WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((label, is_root, role_id, agent, owner_id)) = row else {
      return Ok(None);
    };
    let ceiling = match role_id {
      Some(role_id) => authx::role_access(conn, &role_id)
        .await?
        .map_or(Level::None, |role| role.max_level),
      None => Level::None,
    };
    Ok(Some(Self {
      id: id.to_owned(),
      label,
      is_root,
      agent,
      owner_id,
      ceiling,
    }))
  }

  pub fn relation(
    &self,
    actor_id: &str,
  ) -> Relation {
    if self.id == actor_id {
      Relation::Myself
    } else if self.owner_id.as_deref() == Some(actor_id) {
      Relation::Owner
    } else {
      Relation::Other
    }
  }
}

fn cannot_receive() -> HttpError {
  HttpError::validation(BTreeMap::from([(
    "GRANT_PRINCIPAL_INVALID".into(),
    "This account can't be given access.".into(),
  )]))
}

pub fn self_grant() -> HttpError {
  HttpError::forbidden("SELF_GRANT", "You can't change your own access.")
}

/// Whether the caller may give `account` access, directly or by adding it
/// to a group. People need users.view and AI agents agents.manage; an owner
/// whose role holds agents.view gives their own agent access without
/// either. Nobody gives themselves access, and root takes none. A missing
/// account gets the same answer as one the caller may not see, so ids
/// can't be probed.
pub fn may_give_access(
  identity: &AuthIdentity,
  actor_id: &str,
  account: Option<&Account>,
) -> Result<(), HttpError> {
  let can = |capability| require_capability(identity, capability).is_ok();
  let Some(account) = account else {
    return Err(cannot_receive());
  };
  if account.is_root {
    return Err(cannot_receive());
  }
  let relation = account.relation(actor_id);
  if relation == Relation::Myself {
    return Err(self_grant());
  }
  let allowed = if account.agent {
    (relation == Relation::Owner && can(Capability::AgentsView)) || can(Capability::AgentsManage)
  } else {
    can(Capability::UsersView)
  };
  if !allowed {
    return Err(cannot_receive());
  }
  Ok(())
}

/// Like [`may_give_access`], for a direct grant at `level`, which may not
/// go above what the account's role allows.
pub fn may_grant(
  identity: &AuthIdentity,
  actor_id: &str,
  account: Option<&Account>,
  level: Level,
) -> Result<(), HttpError> {
  may_give_access(identity, actor_id, account)?;
  if account.is_some_and(|account| level > account.ceiling) {
    return Err(HttpError::validation(BTreeMap::from([(
      "GRANT_LEVEL_INVALID".into(),
      "This level is above what the account's role allows.".into(),
    )])));
  }
  Ok(())
}
