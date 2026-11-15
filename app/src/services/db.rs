use anyhow::{Context, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::{fs, str::FromStr, time::Duration};

use crate::config::database_path;

/// The 0.2.0 schema: one baseline migration, plus any added after it.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// What a data directory's database holds, judged before migrating it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Generation {
  /// No tables yet.
  Empty,
  /// Built by this release's migrations, possibly missing newer ones.
  Current,
  /// Built by 0.1.x. It can only come across through `dopbase restore`.
  Legacy,
  /// Records migrations this binary doesn't know: a newer release made it.
  Newer,
}

/// Said whenever a 0.1.x data directory turns up where a 0.2.0 one belongs.
pub const LEGACY_DATA_MESSAGE: &str = "This data directory is from Dopbase 0.1.x. Back it up with your 0.1.x binary, then run `dopbase restore` on a fresh 0.2.0.";

/// Reads which release built the database behind `connection`.
pub async fn generation(
  connection: &mut sqlx::SqliteConnection
) -> Result<Generation, sqlx::Error> {
  let tables: Vec<String> = sqlx::query_scalar(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('_sqlx_migrations', 'admins', 'users')",
  )
  .fetch_all(&mut *connection)
  .await?;
  if tables.iter().any(|name| name == "admins") {
    return Ok(Generation::Legacy);
  }
  if !tables.iter().any(|name| name == "_sqlx_migrations") {
    return Ok(if tables.is_empty() {
      Generation::Empty
    } else {
      Generation::Current
    });
  }
  let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations")
    .fetch_all(&mut *connection)
    .await?;
  let known = |version: &i64| {
    MIGRATOR
      .iter()
      .any(|migration| migration.version == *version)
  };
  let newest = MIGRATOR
    .iter()
    .map(|migration| migration.version)
    .max()
    .unwrap_or(0);
  if applied.iter().all(known) {
    return Ok(if applied.is_empty() && tables.len() == 1 {
      Generation::Empty
    } else {
      Generation::Current
    });
  }
  if applied.iter().any(|version| *version > newest) {
    return Ok(Generation::Newer);
  }
  Ok(Generation::Legacy)
}

/// Refuses a 0.1.x data directory before anything opens its database for
/// writing, so the directory is left exactly as it was.
///
/// The look is read-only and immutable, which creates no `-wal` or `-shm`
/// file. Immutable reads skip SQLite's locks, so a write happening at the
/// same moment can make this look fail or miss tables. That is safe here: it
/// refuses only when it finds the `admins` table or the migration history
/// only 0.1.x has, and on any error it steps aside for the regular checks
/// (the read-only startup probe and [`DbClient::migrate`]).
pub async fn refuse_legacy(url: &str) -> Result<()> {
  if url.contains(":memory:") {
    return Ok(());
  }
  let path = database_path(url)?;
  if !path.is_file() {
    return Ok(());
  }
  let options = SqliteConnectOptions::new()
    .filename(&path)
    .read_only(true)
    .immutable(true);
  // Anything this look can't read (a damaged or foreign file) is left to
  // the regular checks, which report it in their own words.
  let Ok(mut connection) = sqlx::ConnectOptions::connect(&options).await else {
    return Ok(());
  };
  let found = generation(&mut connection).await;
  sqlx::Connection::close(connection).await.ok();
  if matches!(found, Ok(Generation::Legacy)) {
    anyhow::bail!(LEGACY_DATA_MESSAGE);
  }
  Ok(())
}

/// SQLite database client backed by an async sqlx connection pool.
///
/// Cheap to clone because every clone shares the same underlying pool.
#[derive(Clone, Debug)]
pub struct DbClient {
  pool: SqlitePool,
}

impl DbClient {
  /// Open a pooled connection to the SQLite database at `url`
  /// (e.g. `sqlite://./dopbase.db`). The database file is created
  /// when missing.
  pub async fn connect(url: &str) -> Result<Self> {
    let database = (!url.contains(":memory:"))
      .then(|| database_path(url))
      .transpose()?;
    let database_existed = database.as_ref().is_some_and(|path| path.exists());
    if let Some(parent) = database.as_ref().and_then(|path| path.parent()) {
      fs::create_dir_all(parent)
        .with_context(|| format!("failed to create database directory {}", parent.display()))?;
    }
    let options = SqliteConnectOptions::from_str(url)?
      .create_if_missing(true)
      .journal_mode(SqliteJournalMode::Wal)
      .synchronous(SqliteSynchronous::Normal)
      .foreign_keys(true)
      .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
      .max_connections(10)
      .acquire_timeout(Duration::from_secs(5))
      .idle_timeout(Duration::from_secs(60))
      .connect_with(options)
      .await?;

    #[cfg(unix)]
    if !database_existed && let Some(path) = database {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to secure database file {}", path.display()))?;
    }

    Ok(Self { pool })
  }

  /// Run the migrations embedded in the Dopbase executable. A 0.1.x
  /// database is refused untouched: it comes across through a backup and
  /// `dopbase restore`, never in place.
  pub async fn migrate(&self) -> Result<()> {
    let mut connection = self.pool.acquire().await?;
    let found = generation(&mut connection).await?;
    drop(connection);
    if found == Generation::Legacy {
      anyhow::bail!(LEGACY_DATA_MESSAGE);
    }
    MIGRATOR.run(&self.pool).await?;
    Ok(())
  }

  /// Access the underlying pool for ad-hoc queries.
  pub fn pool(&self) -> &SqlitePool {
    &self.pool
  }

  /// Verify the database is reachable.
  pub async fn ping(&self) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT 1")
      .execute(&self.pool)
      .await
      .map(|_| ())
  }

  /// Flush committed WAL pages into the main database before shutdown.
  pub async fn checkpoint(&self) -> Result<(), sqlx::Error> {
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
      .execute(&self.pool)
      .await
      .map(|_| ())
  }

  /// Gracefully close all pooled connections.
  pub async fn close(&self) {
    self.pool.close().await;
  }
}
