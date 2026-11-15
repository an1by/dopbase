//! The 0.1.x schema, kept only so `dopbase restore` can bring a 0.1.x
//! backup up to its final 0.1.x shape before upgrading it to 0.2.0.

use anyhow::Result;
use sqlx::SqlitePool;

/// The 35 migrations 0.1.x shipped, unchanged.
pub static LEGACY_MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations-legacy");

/// Highest version recorded by the sequential naming scheme that shipped
/// through 0.1.9.
const LEGACY_MIGRATION_HEAD: i64 = 18;

/// Brings a 0.1.x database to the last 0.1.x schema.
pub async fn migrate_legacy(pool: &SqlitePool) -> Result<()> {
  adopt_legacy_versions(pool).await?;
  LEGACY_MIGRATOR.run(pool).await?;
  Ok(())
}

/// Carry databases created before migrations switched to timestamped file
/// names onto the current versions.
///
/// 0.1.9 and earlier recorded four-digit versions. The SQL files were only
/// renamed, so every stale row is matched to its current migration by checksum
/// and its version and description are rewritten before sqlx validates the
/// applied set. Rows that match no current migration, or more than one, are
/// left alone so sqlx still reports them.
pub async fn adopt_legacy_versions(pool: &SqlitePool) -> Result<()> {
  let has_migrations: bool = sqlx::query_scalar(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations')",
  )
  .fetch_one(pool)
  .await?;
  if !has_migrations {
    return Ok(());
  }

  let mut transaction = pool.begin().await?;
  let applied: Vec<(i64, Vec<u8>)> = sqlx::query_as(
    "SELECT version, checksum FROM _sqlx_migrations WHERE version <= $1 AND success = 1",
  )
  .bind(LEGACY_MIGRATION_HEAD)
  .fetch_all(&mut *transaction)
  .await?;

  for (legacy_version, checksum) in applied {
    let mut matches = LEGACY_MIGRATOR.iter().filter(|migration| {
      !migration.migration_type.is_down_migration()
        && migration.checksum.as_ref() == checksum.as_slice()
    });
    let (Some(migration), None) = (matches.next(), matches.next()) else {
      continue;
    };
    sqlx::query("UPDATE _sqlx_migrations SET version = $1, description = $2 WHERE version = $3")
      .bind(migration.version)
      .bind(migration.description.as_ref())
      .bind(legacy_version)
      .execute(&mut *transaction)
      .await?;
  }
  transaction.commit().await?;
  Ok(())
}
