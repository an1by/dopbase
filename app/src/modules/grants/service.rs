use super::{model::*, repository, store};
use crate::utils::time::Stamp;
use crate::{
  extractors::{
    require_browser, require_capability, require_mutation, require_person,
    require_recent_browser_auth,
  },
  http::HttpError,
  models::AuthIdentity,
  modules::{accounts::Kind, environments, projects, users},
  services::{
    authx::{self, Capability, Level},
    features::Feature,
  },
  state::AppState,
};
use axum::http::{HeaderMap, StatusCode};
use chrono::Utc;
use std::collections::BTreeMap;

fn not_found() -> HttpError {
  HttpError::not_found("GRANT_NOT_FOUND", "The grant was not found.")
}

fn invalid_level(message: &str) -> HttpError {
  HttpError::validation(BTreeMap::from([(
    "GRANT_LEVEL_INVALID".into(),
    message.into(),
  )]))
}

/// The ids a checked scope stands for.
struct Scope {
  scope_id: String,
  project_id: Option<String>,
}

/// Checks the caller may grant on this scope: root for all projects, a
/// project manager of the project otherwise. Granting never goes above
/// the caller's own level, because a project manager already holds the
/// highest level a project or environment has.
async fn authorize_scope(
  state: &AppState,
  identity: &AuthIdentity,
  scope_type: ScopeType,
  scope: Option<&str>,
) -> Result<Scope, HttpError> {
  let scope = scope.filter(|value| !value.is_empty());
  match (scope_type, scope) {
    (ScopeType::All, None) => {
      require_capability(identity, Capability::GrantsAllProjects)?;
      Ok(Scope {
        scope_id: String::new(),
        project_id: None,
      })
    }
    (ScopeType::Project, Some(reference)) => {
      let project =
        projects::service::authorize(state, identity, reference, Level::ProjectManager).await?;
      Ok(Scope {
        scope_id: project.id.clone(),
        project_id: Some(project.id),
      })
    }
    (ScopeType::Environment, Some(id)) => {
      let environment =
        environments::service::authorize(state, identity, id, Level::Metadata).await?;
      projects::service::authorize(
        state,
        identity,
        &environment.project_id,
        Level::ProjectManager,
      )
      .await?;
      Ok(Scope {
        scope_id: environment.id.clone(),
        project_id: Some(environment.project_id),
      })
    }
    _ => Err(HttpError::validation(BTreeMap::from([(
      "GRANT_SCOPE_INVALID".into(),
      "Name a project or an environment, or leave the scope out for all projects.".into(),
    )]))),
  }
}

/// The owner of the grant's principal when the grant names an AI agent.
/// Groups, people, missing accounts and an agent named as a person are
/// `None`, so a grant of the wrong kind takes the usual checks until
/// `principal_label` refuses it.
async fn principal_agent(
  state: &AppState,
  principal_type: PrincipalType,
  principal_id: &str,
) -> Result<Option<String>, HttpError> {
  if principal_type != PrincipalType::Agent {
    return Ok(None);
  }
  Ok(users::repository::agent(state.db.pool(), principal_id).await?)
}

/// Whether the caller is giving or removing access for an AI agent they
/// own, on one project or environment. Root's all-projects grants always go
/// the usual way.
fn for_own_agent(
  identity: &AuthIdentity,
  actor_id: &str,
  owner: Option<&str>,
  scope_type: ScopeType,
) -> bool {
  scope_type != ScopeType::All
    && owner == Some(actor_id)
    && require_capability(identity, Capability::AgentsView).is_ok()
}

/// Checks an owner may give their own agent `level` here: they must reach
/// the project or environment at that level themselves, so an agent never
/// gets more than its owner has. Protected environments count, because the
/// owner's level on them already does. No access needs only sight of it.
async fn authorize_own_agent_scope(
  state: &AppState,
  identity: &AuthIdentity,
  scope_type: ScopeType,
  scope: Option<&str>,
  level: Level,
) -> Result<Scope, HttpError> {
  let needed = level.max(Level::Metadata);
  match (scope_type, scope.filter(|value| !value.is_empty())) {
    (ScopeType::Project, Some(reference)) => {
      let project = projects::service::authorize(state, identity, reference, needed).await?;
      Ok(Scope {
        scope_id: project.id.clone(),
        project_id: Some(project.id),
      })
    }
    (ScopeType::Environment, Some(id)) => {
      let environment = environments::service::authorize(state, identity, id, needed).await?;
      Ok(Scope {
        scope_id: environment.id.clone(),
        project_id: Some(environment.project_id),
      })
    }
    _ => authorize_scope(state, identity, scope_type, scope).await,
  }
}

fn validate_level(
  scope_type: ScopeType,
  level: Level,
) -> Result<(), HttpError> {
  match (scope_type, level) {
    (ScopeType::Environment, Level::ProjectManager) => Err(invalid_level(
      "Project manager is given on a project, not on one environment.",
    )),
    (ScopeType::All | ScopeType::Project, Level::None) => Err(invalid_level(
      "No access is set on one environment. Remove the grant instead.",
    )),
    _ => Ok(()),
  }
}

fn self_grant() -> HttpError {
  users::authority::self_grant()
}

fn principal_invalid() -> HttpError {
  HttpError::validation(BTreeMap::from([(
    "GRANT_PRINCIPAL_INVALID".into(),
    "This account can't be given access.".into(),
  )]))
}

/// The principal's label, after checking a grant at `level` may be given
/// to it. A caller grants to groups and people they may list, to AI agents
/// with agents.manage, and to their own agents, as the Admin UI offers, so
/// ids, root and role ceilings can't be probed.
async fn principal_label(
  conn: &mut sqlx::SqliteConnection,
  identity: &AuthIdentity,
  actor_id: &str,
  principal_type: PrincipalType,
  principal_id: &str,
  level: Level,
) -> Result<String, HttpError> {
  let can = |capability| require_capability(identity, capability).is_ok();
  // Seeing a group needs groups.manage held by the role, even while RBAC
  // is off, or users.view.
  let sees_groups = matches!(identity, AuthIdentity::Admin { access, .. } if access.holds(Capability::GroupsManage));
  match principal_type {
    PrincipalType::Group if !sees_groups && !can(Capability::UsersView) => Err(principal_invalid()),
    PrincipalType::Group => repository::group_name(conn, principal_id)
      .await?
      .ok_or_else(|| HttpError::not_found("GROUP_NOT_FOUND", "The group was not found.")),
    // The same rule decides who may be added to a group. The type must
    // match what the id is, so a person can't be granted as an agent or the
    // other way round.
    PrincipalType::User | PrincipalType::Agent => {
      let account = users::authority::Account::load(conn, principal_id)
        .await?
        .filter(|account| account.agent == (principal_type == PrincipalType::Agent));
      users::authority::may_grant(identity, actor_id, account.as_ref(), level)?;
      Ok(account.map(|account| account.label).unwrap_or_default())
    }
  }
}

pub async fn set(
  state: &AppState,
  identity: &AuthIdentity,
  headers: &HeaderMap,
  request: SetGrantRequest,
) -> Result<GrantResponse, HttpError> {
  require_mutation(identity, headers)?;
  require_recent_browser_auth(identity)?;
  let (actor_id, actor_email) = require_browser(identity)?;
  validate_level(request.scope_type, request.level)?;
  let agent = principal_agent(state, request.principal_type, &request.principal_id).await?;
  let own_agent = for_own_agent(identity, actor_id, agent.as_deref(), request.scope_type);
  let scope = if own_agent {
    authorize_own_agent_scope(
      state,
      identity,
      request.scope_type,
      request.scope.as_deref(),
      request.level,
    )
    .await?
  } else {
    authorize_scope(
      state,
      identity,
      request.scope_type,
      request.scope.as_deref(),
    )
    .await?
  };
  let now = Utc::now().stamp();
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let label = principal_label(
    &mut tx,
    identity,
    actor_id,
    request.principal_type,
    &request.principal_id,
    request.level,
  )
  .await?;
  // Without RBAC only AI agents take new access. Checked once the caller
  // may grant here and see the principal, so the answer says nothing about
  // accounts they can't.
  if agent.is_none() {
    state.config.features.require(Feature::Rbac)?;
  }
  let id = store::set(
    &mut tx,
    store::Actor {
      actor_type: identity.audit_actor_type(),
      id: actor_id,
      label: actor_email,
    },
    store::Change {
      principal_type: request.principal_type,
      principal_id: &request.principal_id,
      principal_label: &label,
      scope_type: request.scope_type,
      scope_id: &scope.scope_id,
      project_id: scope.project_id.as_deref(),
      level: request.level,
    },
    &now,
  )
  .await?;
  tx.commit().await?;
  let mut conn = state.db.pool().acquire().await?;
  repository::find(&mut conn, &id)
    .await?
    .ok_or_else(HttpError::internal)
}

pub async fn delete(
  state: &AppState,
  identity: &AuthIdentity,
  headers: &HeaderMap,
  id: &str,
) -> Result<(), HttpError> {
  require_mutation(identity, headers)?;
  require_recent_browser_auth(identity)?;
  let (actor_id, actor_email) = require_browser(identity)?;
  let mut conn = state.db.pool().acquire().await?;
  let grant = repository::find(&mut conn, id)
    .await?
    .ok_or_else(not_found)?;
  drop(conn);
  let agent = principal_agent(state, grant.principal_type, &grant.principal_id).await?;
  let own_agent = for_own_agent(identity, actor_id, agent.as_deref(), grant.scope_type);
  // A grant on something the caller cannot see does not exist for them. An
  // owner takes access away from their own agent wherever they can see.
  let checked = if own_agent {
    authorize_own_agent_scope(
      state,
      identity,
      grant.scope_type,
      Some(&grant.scope_id),
      Level::Metadata,
    )
    .await
  } else {
    authorize_scope(state, identity, grant.scope_type, Some(&grant.scope_id)).await
  };
  checked.map_err(|error| {
    if error.status == StatusCode::NOT_FOUND {
      not_found()
    } else {
      error
    }
  })?;
  // Without RBAC only AI agents lose access. Checked once the caller can
  // see the grant, so the answer says nothing about grants they can't.
  if agent.is_none() {
    state.config.features.require(Feature::Rbac)?;
  }
  if grant.principal_type == PrincipalType::User && grant.principal_id == actor_id {
    return Err(self_grant());
  }
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let removed = store::remove(
    &mut tx,
    store::Actor {
      actor_type: identity.audit_actor_type(),
      id: actor_id,
      label: actor_email,
    },
    &grant,
  )
  .await?;
  if !removed {
    return Err(not_found());
  }
  tx.commit().await?;
  Ok(())
}

/// Who can reach a project. Its project managers can see this, and so can
/// anyone whose role reports on access.
pub async fn project_access(
  state: &AppState,
  identity: &AuthIdentity,
  reference: &str,
) -> Result<ProjectAccessResponse, HttpError> {
  require_person(identity)?;
  let needed = match identity {
    AuthIdentity::Admin { access, .. } if access.has(Capability::AccessReport) => Level::Metadata,
    _ => Level::ProjectManager,
  };
  let project = projects::service::authorize(state, identity, reference, needed).await?;
  let environments = environments::service::list(state, identity, Some(&project.id)).await?;
  let grants = repository::for_project(state.db.pool(), &project.id).await?;
  Ok(ProjectAccessResponse {
    project,
    environments,
    grants,
  })
}

/// Where an account of `kind` comes by its access. Anyone can see their
/// own. A person's needs users.view; an AI agent's needs agents.view_all,
/// or agents.view when the caller owns it. An account of the other kind
/// gets the answer a missing one does.
pub async fn user_access(
  state: &AppState,
  identity: &AuthIdentity,
  id: &str,
  kind: Kind,
) -> Result<UserAccessResponse, HttpError> {
  // A personal token can ask about its own account only.
  let (actor_id, token) = match identity {
    AuthIdentity::Token {
      admin_id,
      token_name,
      scope,
      level,
      audit,
      ..
    } => (
      admin_id.as_str(),
      Some(TokenLimit {
        name: token_name.clone(),
        scope_type: match scope {
          _ if *audit => ScopeType::Audit,
          authx::Scope::All => ScopeType::All,
          authx::Scope::Project(_) => ScopeType::Project,
          authx::Scope::Environment(_) => ScopeType::Environment,
        },
        scope_id: match scope {
          authx::Scope::All => String::new(),
          authx::Scope::Project(id) | authx::Scope::Environment(id) => id.clone(),
        },
        scope_label: String::new(),
        level: *level,
      }),
    ),
    _ => (require_person(identity)?.0, None),
  };
  let required = kind.required_for(id);
  let id = if id == "me" { actor_id } else { id };
  if id != actor_id {
    // An AI agent's access shows to its owner and to agents.view_all;
    // a person's to users.view. A missing id, or one of the other kind,
    // needs what someone else's account of this kind does, so it can't be
    // told apart from one the caller may not see.
    let owner = match kind {
      Kind::Agent => users::repository::agent(state.db.pool(), id).await?,
      Kind::User => None,
    };
    let needed = match (kind, owner) {
      (Kind::Agent, Some(owner)) if owner == actor_id => Capability::AgentsView,
      (Kind::Agent, _) => Capability::AgentsViewAll,
      (Kind::User, _) => Capability::UsersView,
    };
    require_capability(identity, needed)?;
  }
  let mut conn = state.db.pool().acquire().await?;
  let email: Option<String> = sqlx::query_scalar(
    "SELECT label FROM account_profiles WHERE id = $1 AND ($2 IS NULL OR kind = $2)",
  )
  .bind(id)
  .bind(required.map(Kind::as_str))
  .fetch_optional(&mut *conn)
  .await?;
  let Some(email) = email else {
    return Err(kind.not_found());
  };
  let access = authx::load_access(&mut conn, id, &state.config.features).await?;
  let mut token = token;
  if let Some(token) = token.as_mut() {
    token.scope_label = sqlx::query_scalar(
      "SELECT COALESCE((SELECT name FROM projects WHERE id = $1), (SELECT p.name || '/' || e.name FROM environments e JOIN projects p ON p.id = e.project_id WHERE e.id = $1), '')",
    )
    .bind(&token.scope_id)
    .fetch_one(&mut *conn)
    .await?;
  }
  let mut grants = repository::for_user(state.db.pool(), id).await?;
  let owner_email = match users::repository::agent(state.db.pool(), id).await? {
    Some(owner_id) => {
      cap_by_owner(&mut conn, &state.config.features, &owner_id, &mut grants).await?
    }
    None => None,
  };
  drop(conn);
  Ok(UserAccessResponse {
    user_id: id.to_owned(),
    email,
    role_name: access
      .as_ref()
      .map_or_else(String::new, |access| access.role_name.clone()),
    owner_email,
    max_level: access.map_or(Level::None, |access| access.max_level),
    token,
    groups: repository::groups_of(state.db.pool(), id).await?,
    grants,
  })
}

/// Marks each of an AI agent's grants that its owner doesn't back in full
/// with the owner's own level there, and returns the owner's email. A
/// missing or disabled owner backs nothing, the same as when the agent
/// calls the API.
async fn cap_by_owner(
  conn: &mut sqlx::SqliteConnection,
  features: &crate::services::features::Features,
  owner_id: &str,
  grants: &mut [GrantResponse],
) -> Result<Option<String>, HttpError> {
  // A disabled owner reaches nothing, so neither does the agent.
  let owner = match authx::load_access(conn, owner_id, features).await? {
    Some(access) => Some(authx::account_data_access(conn, owner_id, &access).await?),
    None => None,
  };
  for grant in grants.iter_mut() {
    let owner_level = match (&owner, grant.scope_type) {
      (None, _) => Level::None,
      (Some(owner), ScopeType::Project) => owner.project(&grant.project_id),
      (Some(owner), ScopeType::Environment) => {
        let protected: bool =
          sqlx::query_scalar("SELECT protected FROM environments WHERE id = $1")
            .bind(&grant.scope_id)
            .fetch_optional(&mut *conn)
            .await?
            .unwrap_or(false);
        owner.environment(authx::EnvironmentTarget {
          project_id: &grant.project_id,
          environment_id: &grant.scope_id,
          protected,
        })
      }
      // Agents get no all-projects or audit grants.
      (Some(_), _) => continue,
    };
    if owner_level < grant.level {
      grant.owner_level = Some(owner_level);
    }
  }
  Ok(
    sqlx::query_scalar("SELECT email FROM users WHERE id = $1")
      .bind(owner_id)
      .fetch_optional(&mut *conn)
      .await?,
  )
}
