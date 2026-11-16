//! The one list of tables that hold an instance's data. Factory reset,
//! backup and restore all work from it, so adding a table is one edit.

use sqlx::SqliteConnection;

/// Every table with instance data, parents before children. Insert in this
/// order and delete in reverse. `instance_metadata` is left out: it holds
/// the instance's own key check, not data.
pub const INSTANCE_TABLES: [&str; 25] = [
  "roles",
  "role_capabilities",
  "accounts",
  "users",
  "agents",
  "sessions",
  "sso_providers",
  "user_identities",
  "sso_flows",
  "cli_device_requests",
  "passcodes",
  "projects",
  "workspaces",
  "project_locations",
  "environments",
  "secrets",
  "secret_versions",
  "runner_tokens",
  "personal_tokens",
  "workspace_tokens",
  "groups",
  "group_members",
  "grants",
  "audit_events",
  "audit_chain_anchor",
];

/// Deletes every row of instance data, children first. Built-in roles and
/// their capabilities come from the baseline migration and stay.
pub async fn wipe(connection: &mut SqliteConnection) -> Result<(), sqlx::Error> {
  for table in INSTANCE_TABLES.iter().rev() {
    let statement = match *table {
      "roles" => "DELETE FROM roles WHERE builtin = 0",
      "role_capabilities" => {
        "DELETE FROM role_capabilities WHERE role_id IN (SELECT id FROM roles WHERE builtin = 0)"
      }
      table => {
        sqlx::query(&format!("DELETE FROM {table}"))
          .execute(&mut *connection)
          .await?;
        continue;
      }
    };
    sqlx::query(statement).execute(&mut *connection).await?;
  }
  Ok(())
}

