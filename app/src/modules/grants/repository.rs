use super::model::{GrantResponse, GroupRef, PrincipalType, ScopeType};
use crate::services::authx::Level;
use sqlx::{SqliteConnection, SqlitePool};

/// Every grant with its labels. Each principal and scope is a foreign key,
/// so the labels are plain joins: `p.name || '/' || NULL` is NULL, so the
/// scope label falls back to the project name, then to empty for all
/// projects.
const SELECT: &str = "SELECT g.id, g.account_id, g.group_id, g.scope, g.project_id, g.environment_id, g.level, \
  COALESCE(acc.label, gr.name, '') AS principal_label, \
  COALESCE(acc.kind = 'agent', FALSE) AS principal_agent, \
  COALESCE(p.name || '/' || e.name, p.name, '') AS scope_label, \
  g.granted_by, g.created_at \
  FROM grants g \
  LEFT JOIN account_profiles acc ON acc.id = g.account_id \
  LEFT JOIN groups gr ON gr.id = g.group_id \
  LEFT JOIN projects p ON p.id = g.project_id \
  LEFT JOIN environments e ON e.id = g.environment_id";

#[derive(sqlx::FromRow)]
struct GrantRow {
  id: String,
  account_id: Option<String>,
  group_id: Option<String>,
  scope: String,
  project_id: Option<String>,
  environment_id: Option<String>,
  level: String,
  principal_label: String,
  principal_agent: bool,
  scope_label: String,
  granted_by: Option<String>,
  created_at: String,
}

impl GrantRow {
  fn response(self) -> Option<GrantResponse> {
    let (principal_type, principal_id) = match (self.account_id, self.group_id) {
      (Some(account_id), None) if self.principal_agent => (PrincipalType::Agent, account_id),
      (Some(account_id), None) => (PrincipalType::User, account_id),
      (None, Some(group_id)) => (PrincipalType::Group, group_id),
      _ => return None,
    };
    let scope_type = ScopeType::parse(&self.scope)?;
    let scope_id = self
      .environment_id
      .clone()
      .or_else(|| self.project_id.clone())
      .unwrap_or_default();
    Some(GrantResponse {
      id: self.id,
      principal_type,
      principal_id,
      principal_label: self.principal_label,
      scope_type,
      scope_id,
      scope_label: self.scope_label,
      project_id: self.project_id.unwrap_or_default(),
      level: Level::parse(&self.level)?,
      granted_by: self.granted_by,
      created_at: self.created_at,
      owner_level: None,
    })
  }
}

fn responses(rows: Vec<GrantRow>) -> Vec<GrantResponse> {
  rows.into_iter().filter_map(GrantRow::response).collect()
}

pub async fn find(
  conn: &mut SqliteConnection,
  id: &str,
) -> Result<Option<GrantResponse>, sqlx::Error> {
  let row: Option<GrantRow> = sqlx::query_as(&format!("{SELECT} WHERE g.id = $1"))
    .bind(id)
    .fetch_optional(conn)
    .await?;
  Ok(row.and_then(GrantRow::response))
}

/// Grants on a project and on each of its environments.
pub async fn for_project(
  pool: &SqlitePool,
  project_id: &str,
) -> Result<Vec<GrantResponse>, sqlx::Error> {
  let rows = sqlx::query_as(&format!(
    "{SELECT} WHERE g.project_id = $1 ORDER BY g.scope DESC, scope_label, principal_label"
  ))
  .bind(project_id)
  .fetch_all(pool)
  .await?;
  Ok(responses(rows))
}

/// An account's own grants and those of its groups.
pub async fn for_user(
  pool: &SqlitePool,
  user_id: &str,
) -> Result<Vec<GrantResponse>, sqlx::Error> {
  let rows = sqlx::query_as(&format!(
    "{SELECT} WHERE g.account_id = $1 OR g.group_id IN (SELECT group_id FROM group_members WHERE account_id = $1) ORDER BY scope_label, g.group_id IS NOT NULL"
  ))
  .bind(user_id)
  .fetch_all(pool)
  .await?;
  Ok(responses(rows))
}

pub async fn for_group(
  conn: &mut SqliteConnection,
  group_id: &str,
) -> Result<Vec<GrantResponse>, sqlx::Error> {
  let rows = sqlx::query_as(&format!(
    "{SELECT} WHERE g.group_id = $1 ORDER BY scope_label"
  ))
  .bind(group_id)
  .fetch_all(conn)
  .await?;
  Ok(responses(rows))
}

/// The grants of every group, each group's by scope.
pub async fn for_groups(pool: &SqlitePool) -> Result<Vec<GrantResponse>, sqlx::Error> {
  let rows = sqlx::query_as(&format!(
    "{SELECT} WHERE g.group_id IS NOT NULL ORDER BY scope_label"
  ))
  .fetch_all(pool)
  .await?;
  Ok(responses(rows))
}

pub async fn groups_of(
  pool: &SqlitePool,
  user_id: &str,
) -> Result<Vec<GroupRef>, sqlx::Error> {
  sqlx::query_as("SELECT g.id, g.name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.account_id = $1 ORDER BY g.name")
    .bind(user_id)
    .fetch_all(pool)
    .await
}

/// The principal and scope columns a grant is stored under. An
/// environment grant also stores its project, looked up from the
/// environment, so the composite key keeps it inside that project.
struct Key<'a> {
  account_id: Option<&'a str>,
  group_id: Option<&'a str>,
  scope: &'static str,
  project_id: Option<&'a str>,
  environment_id: Option<&'a str>,
}

impl<'a> Key<'a> {
  fn new(
    principal_type: PrincipalType,
    principal_id: &'a str,
    scope_type: ScopeType,
    scope_id: &'a str,
  ) -> Self {
    let (account_id, group_id) = match principal_type {
      PrincipalType::User | PrincipalType::Agent => (Some(principal_id), None),
      PrincipalType::Group => (None, Some(principal_id)),
    };
    let (project_id, environment_id) = match scope_type {
      // Grants never take the audit scope; the schema refuses it.
      ScopeType::All | ScopeType::Audit => (None, None),
      ScopeType::Project => (Some(scope_id), None),
      ScopeType::Environment => (None, Some(scope_id)),
    };
    Self {
      account_id,
      group_id,
      scope: scope_type.as_str(),
      project_id,
      environment_id,
    }
  }

  /// The unique index an upsert on this key conflicts with. There is one
  /// per principal kind and scope, so Rust picks it.
  fn conflict_target(&self) -> &'static str {
    match (self.account_id.is_some(), self.scope) {
      (true, "all") => "(account_id) WHERE scope = 'all'",
      (false, "all") => "(group_id) WHERE scope = 'all'",
      (true, "project") => "(account_id, project_id) WHERE scope = 'project'",
      (false, "project") => "(group_id, project_id) WHERE scope = 'project'",
      (true, _) => "(account_id, environment_id)",
      (false, _) => "(group_id, environment_id)",
    }
  }

  /// The WHERE clause that finds this key's grant, binding `$1` to the
  /// principal and `$2` to the scope's id.
  fn filter(&self) -> &'static str {
    match (self.account_id.is_some(), self.scope) {
      (true, "all") => "account_id = $1 AND scope = 'all' AND $2 = ''",
      (false, "all") => "group_id = $1 AND scope = 'all' AND $2 = ''",
      (true, "project") => "account_id = $1 AND scope = 'project' AND project_id = $2",
      (false, "project") => "group_id = $1 AND scope = 'project' AND project_id = $2",
      (true, _) => "account_id = $1 AND environment_id = $2",
      (false, _) => "group_id = $1 AND environment_id = $2",
    }
  }

  fn principal(&self) -> &'a str {
    self.account_id.or(self.group_id).unwrap_or_default()
  }

  fn scope_id(&self) -> &'a str {
    self.environment_id.or(self.project_id).unwrap_or_default()
  }
}

/// The level a principal already holds on a scope.
pub async fn existing_level(
  conn: &mut SqliteConnection,
  principal_type: PrincipalType,
  principal_id: &str,
  scope_type: ScopeType,
  scope_id: &str,
) -> Result<Option<String>, sqlx::Error> {
  let key = Key::new(principal_type, principal_id, scope_type, scope_id);
  sqlx::query_scalar(&format!("SELECT level FROM grants WHERE {}", key.filter()))
    .bind(key.principal())
    .bind(key.scope_id())
    .fetch_optional(conn)
    .await
}

pub struct NewGrant<'a> {
  pub id: &'a str,
  pub principal_type: PrincipalType,
  pub principal_id: &'a str,
  pub scope_type: ScopeType,
  pub scope_id: &'a str,
  pub level: Level,
  pub granted_by: &'a str,
  pub now: &'a str,
}

/// Creates the grant, or changes the level of the one already on that
/// scope, keeping its id and creation time. Returns the grant's id.
pub async fn upsert(
  conn: &mut SqliteConnection,
  grant: NewGrant<'_>,
) -> Result<String, sqlx::Error> {
  let key = Key::new(
    grant.principal_type,
    grant.principal_id,
    grant.scope_type,
    grant.scope_id,
  );
  sqlx::query_scalar(&format!(
    "INSERT INTO grants(id, account_id, group_id, scope, project_id, environment_id, level, granted_by, created_at, updated_at) \
     VALUES($1, $2, $3, $4, COALESCE($5, (SELECT project_id FROM environments WHERE id = $6)), $6, $7, $8, $9, $9) \
     ON CONFLICT {} DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by, updated_at = excluded.updated_at \
     RETURNING id",
    key.conflict_target()
  ))
  .bind(grant.id)
  .bind(key.account_id)
  .bind(key.group_id)
  .bind(key.scope)
  .bind(key.project_id)
  .bind(key.environment_id)
  .bind(grant.level.as_str())
  .bind(grant.granted_by)
  .bind(grant.now)
  .fetch_one(conn)
  .await
}

pub async fn delete(
  conn: &mut SqliteConnection,
  id: &str,
) -> Result<bool, sqlx::Error> {
  Ok(
    sqlx::query("DELETE FROM grants WHERE id = $1")
      .bind(id)
      .execute(conn)
      .await?
      .rows_affected()
      == 1,
  )
}

pub async fn group_name(
  conn: &mut SqliteConnection,
  id: &str,
) -> Result<Option<String>, sqlx::Error> {
  sqlx::query_scalar("SELECT name FROM groups WHERE id = $1")
    .bind(id)
    .fetch_optional(conn)
    .await
}
