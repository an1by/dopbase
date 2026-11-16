//! Workspace tables are fork-only on some 0.1.x instances and always part
//! of 0.2.0. Upgrade copies them when present and backfills a default layout
//! for plain upstream 0.1.x backups.

use anyhow::Context;
use sqlx::{SqliteConnection, Transaction};

use super::upgrade::UpgradeReport;
use crate::{
  constants::workspaces as workspace_ids,
  modules::workspaces::DEFAULT_WORKSPACE_ROOT_PATH,
};

async fn count(connection: &mut SqliteConnection, sql: &str) -> anyhow::Result<i64> {
  Ok(sqlx::query_scalar(sql).fetch_one(connection).await?)
}

async fn table_exists(connection: &mut SqliteConnection, table: &str) -> anyhow::Result<bool> {
  Ok(
    sqlx::query_scalar(&format!(
      "SELECT EXISTS(SELECT 1 FROM old.sqlite_master WHERE type='table' AND name='{table}')"
    ))
    .fetch_one(connection)
    .await?,
  )
}

fn ts(column: &str) -> String {
  format!("COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', {column}), {column})")
}

pub(super) async fn upgrade_workspaces(
  tx: &mut Transaction<'_, sqlx::Sqlite>,
  report: &mut UpgradeReport,
  now: &str,
) -> anyhow::Result<()> {
  if table_exists(&mut *tx, "workspaces").await? {
    let rows = count(&mut *tx, "SELECT COUNT(*) FROM old.workspaces").await?;
    if rows > 0 {
      sqlx::query(&format!(
        "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) \
         SELECT id, name, root_path, {}, {} FROM old.workspaces",
        ts("created_at"),
        ts("updated_at"),
      ))
      .execute(&mut **tx)
      .await
      .context("copying workspaces")?;
      UpgradeReport::note(
        &mut report.changed,
        "workspaces",
        rows,
        "carried across from the backup",
      );
    }
  }

  if table_exists(&mut *tx, "project_locations").await? {
    let before = count(&mut *tx, "SELECT COUNT(*) FROM old.project_locations").await?;
    sqlx::query(
      "INSERT INTO project_locations (project_id, workspace_id, relative_path) \
       SELECT project_id, workspace_id, relative_path FROM old.project_locations \
       WHERE project_id IN (SELECT id FROM projects) AND workspace_id IN (SELECT id FROM workspaces)",
    )
    .execute(&mut **tx)
    .await
    .context("copying project locations")?;
    let copied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM project_locations")
      .fetch_one(&mut **tx)
      .await?;
    let kept = copied.min(before);
    if before > kept {
      UpgradeReport::note(
        &mut report.dropped,
        "project_locations",
        before - kept,
        "named a project or workspace that no longer exists",
      );
    }
    if kept > 0 {
      UpgradeReport::note(
        &mut report.changed,
        "project_locations",
        kept,
        "carried across from the backup",
      );
    }
  }

  if table_exists(&mut *tx, "workspace_tokens").await? {
    let rows = count(
      &mut *tx,
      "SELECT COUNT(*) FROM old.workspace_tokens WHERE workspace_id IN (SELECT id FROM old.workspaces)",
    )
    .await?;
    sqlx::query(&format!(
      "INSERT INTO workspace_tokens (id, workspace_id, name, token_hash, created_at, expires_at, last_used_at, revoked_at) \
       SELECT id, workspace_id, name, token_hash, {}, {}, {}, {} FROM old.workspace_tokens \
        WHERE workspace_id IN (SELECT id FROM workspaces)",
      ts("created_at"),
      ts("expires_at"),
      ts("last_used_at"),
      ts("revoked_at"),
    ))
    .execute(&mut **tx)
    .await
    .context("copying workspace tokens")?;
    if rows > 0 {
      UpgradeReport::note(
        &mut report.changed,
        "workspace_tokens",
        rows,
        "carried across from the backup",
      );
    }
  }

  if count(&mut *tx, "SELECT COUNT(*) FROM workspaces").await? == 0 {
    sqlx::query(
      "INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)",
    )
    .bind(workspace_ids::DEFAULT_WORKSPACE_ID)
    .bind(workspace_ids::DEFAULT_WORKSPACE_NAME)
    .bind(DEFAULT_WORKSPACE_ROOT_PATH)
    .bind(now)
    .execute(&mut **tx)
    .await
    .context("creating the default workspace")?;
    UpgradeReport::note(
      &mut report.changed,
      "workspaces",
      1,
      "created default workspace for a 0.1.x backup",
    );
  }

  let unlocated: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM projects p WHERE NOT EXISTS (SELECT 1 FROM project_locations l WHERE l.project_id = p.id)",
  )
  .fetch_one(&mut **tx)
  .await?;
  if unlocated > 0 {
    sqlx::query(
      "INSERT INTO project_locations (project_id, workspace_id, relative_path) \
       SELECT p.id, $1, p.name FROM projects p \
       WHERE NOT EXISTS (SELECT 1 FROM project_locations l WHERE l.project_id = p.id) \
         AND EXISTS (SELECT 1 FROM workspaces WHERE id = $1)",
    )
    .bind(workspace_ids::DEFAULT_WORKSPACE_ID)
    .execute(&mut **tx)
    .await
    .context("linking projects to the default workspace")?;
    UpgradeReport::note(
      &mut report.changed,
      "project_locations",
      unlocated,
      "linked each project into the default workspace",
    );
  }

  Ok(())
}