//! The instance snapshot: what a backup file holds and how it goes back
//! into a running instance. Creating a backup, uploading one, restoring
//! one and restoring during setup all go through here, so they check and
//! re-key a backup the same way and copy the same tables.
//!
//! This is the SQLite adapter. It snapshots with `VACUUM INTO` and restores
//! by attaching the prepared file and copying table by table in one
//! transaction. A Postgres instance would need its own adapter behind the
//! same three steps: [`create`], [`prepare`], [`apply`].

use std::{
  fs::File,
  io::{Cursor, Write},
  path::{Path, PathBuf},
};

use anyhow::Context;
use chrono::Utc;
use sqlx::{Connection, SqliteConnection};
use tempfile::TempDir;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use super::{model::BackupManifest, upgrade};
use crate::{
  constants::config::AUDIT_ARCHIVE_DIRECTORY_NAME,
  http::HttpError,
  modules::common,
  services::{
    db::{DbClient, Generation, MIGRATOR, generation},
    instance_tables::INSTANCE_TABLES,
  },
  state::AppState,
  utils::time::Stamp,
};

/// Backups written by 0.2.0 and later.
pub const MANIFEST_MAGIC: &str = "DOPBASE_BACKUP_V3";
/// Backups written by 0.1.x. Restore upgrades them on the way in.
pub const LEGACY_MANIFEST_MAGIC: &str = "DOPBASE_BACKUP_V2";
pub const MAX_BACKUP_FILE_BYTES: usize = 250 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
/// Where a backup carries the audit records a 0.1.x upgrade set aside. They
/// reach this server's audit archive only when the backup is restored.
const AUDIT_ARCHIVE_ENTRY: &str = "audit-archive/";
/// How many such files one backup may carry.
const MAX_AUDIT_ARCHIVE_FILES: usize = 16;

/// Whether `name` is a file the 0.1.x upgrade writes
/// (`audit-0.1.x-<first>-<last>.jsonl`), and so safe to join to a directory.
fn audit_archive_name(name: &str) -> bool {
  name.len() <= 200
    && name.starts_with("audit-0.1.x-")
    && name.ends_with(".jsonl")
    && name
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    && !name.contains("..")
}

fn invalid(
  code: &str,
  message: &str,
) -> HttpError {
  HttpError::bad_request(code, message)
}

/// The cause names environment ids, secret keys and database internals, so
/// it goes to the log and the caller gets a fixed message.
pub(crate) fn rekey_failed() -> HttpError {
  invalid(
    "BACKUP_REKEY_FAILED",
    "The backup could not be re-keyed with this master key.",
  )
}

fn internal(error: impl std::fmt::Display) -> HttpError {
  tracing::error!(%error, "backup snapshot failed");
  HttpError::internal()
}

/// Zips a manifest, a database file and any audit archive files and
/// encrypts the result with this server's master key. Runs off the async
/// workers.
async fn seal_file(
  state: &AppState,
  db_path: PathBuf,
  name: String,
  audit_archives: Vec<PathBuf>,
) -> Result<Vec<u8>, HttpError> {
  let crypto = state.crypto.clone();
  tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
    let manifest = BackupManifest {
      version: env!("CARGO_PKG_VERSION").into(),
      created_at: Utc::now().stamp(),
      backup_name: name,
      magic: MANIFEST_MAGIC.into(),
    };
    let db_bytes = std::fs::read(&db_path)?;
    let mut buffer = Cursor::new(Vec::new());
    {
      let mut zip = ZipWriter::new(&mut buffer);
      let options =
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
      zip.start_file("manifest.json", options)?;
      zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
      zip.start_file("dopbase.db", options)?;
      zip.write_all(&db_bytes)?;
      for path in &audit_archives {
        let file_name = path
          .file_name()
          .and_then(|name| name.to_str())
          .context("audit archive file has no name")?;
        zip.start_file(format!("{AUDIT_ARCHIVE_ENTRY}{file_name}"), options)?;
        zip.write_all(&std::fs::read(path)?)?;
      }
      zip.finish()?;
    }
    crypto.encrypt_backup(&buffer.into_inner())
  })
  .await
  .map_err(internal)?
  .map_err(internal)
}

/// An encrypted backup of the live database, named `name`.
pub async fn create(
  state: &AppState,
  name: &str,
) -> Result<Vec<u8>, HttpError> {
  let temp_dir = tempfile::tempdir().map_err(internal)?;
  let db_path = temp_dir.path().join("snapshot.db");
  let escaped = db_path.to_string_lossy().replace('\'', "''");
  sqlx::query(&format!("VACUUM INTO '{escaped}'"))
    .execute(state.db.pool())
    .await
    .map_err(internal)?;
  let sealed = seal_file(state, db_path, name.to_owned(), Vec::new()).await;
  drop(temp_dir);
  sealed
}

/// Why a backup file couldn't be opened.
#[derive(Debug)]
pub enum Unopened {
  /// This server's key doesn't open it and no other key was given.
  KeyRequired,
  /// Neither this server's key nor the given one opens it.
  WrongKey,
}

/// A backup file that opened.
pub struct Opened {
  /// The decrypted archive.
  pub archive: Vec<u8>,
  /// The key that opened it, when it wasn't this server's: the data keys
  /// are re-wrapped from it.
  pub rekey_from: Option<Vec<u8>>,
  /// The file as given, to keep when nothing needs changing.
  pub file: Vec<u8>,
}

/// Decrypts a backup file with this server's key, or the given one when
/// that fails, off the async workers.
pub async fn open_file(
  state: &AppState,
  file: Vec<u8>,
  provided_key: Option<&[u8]>,
) -> Result<Result<Opened, Unopened>, HttpError> {
  let crypto = state.crypto.clone();
  let provided_key = provided_key.map(<[u8]>::to_vec);
  tokio::task::spawn_blocking(move || {
    if let Ok(archive) = crypto.decrypt_backup(&file) {
      return Ok(Opened {
        archive,
        rekey_from: None,
        file,
      });
    }
    let Some(key) = provided_key else {
      return Err(Unopened::KeyRequired);
    };
    let archive = crate::services::crypto::CryptoService::decrypt_backup_with_key(&file, &key)
      .map_err(|_| Unopened::WrongKey)?;
    Ok(Opened {
      archive,
      rekey_from: Some(key),
      file,
    })
  })
  .await
  .map_err(internal)
}

/// A backup's database, unpacked into a temporary directory, brought to
/// this release's schema, checked, and keyed to this server. Nothing live
/// has been touched yet. The directory goes when this is dropped.
pub struct Prepared {
  _dir: TempDir,
  path: PathBuf,
  /// What upgrading a 0.1.x backup did, when it was one.
  pub upgrade: Option<upgrade::UpgradeReport>,
  /// Audit records a 0.1.x upgrade set aside, as files in the temporary
  /// directory. A sealed backup carries them; a restore writes them to
  /// this server's audit archive.
  audit_archives: Vec<PathBuf>,
}

/// A decrypted backup, unpacked into a temporary directory.
struct Unpacked {
  dir: TempDir,
  db_path: PathBuf,
  manifest: BackupManifest,
  audit_archives: Vec<PathBuf>,
}

/// Unpacks a decrypted backup archive into a temporary directory.
async fn unpack(decrypted: Vec<u8>) -> Result<Unpacked, HttpError> {
  tokio::task::spawn_blocking(move || {
    let dir = tempfile::tempdir().map_err(internal)?;
    let path = dir.path().join("restore.db");
    let mut archive = ZipArchive::new(Cursor::new(decrypted))
      .map_err(|_| invalid("BACKUP_CORRUPT", "Corrupted archive."))?;
    let mut manifest_bytes = Vec::new();
    {
      let mut entry = archive
        .by_name("manifest.json")
        .map_err(|_| invalid("BACKUP_CORRUPT", "Missing manifest in backup."))?;
      if entry.size() > MAX_MANIFEST_BYTES {
        return Err(invalid("BACKUP_CORRUPT", "Backup manifest is too large."));
      }
      std::io::copy(&mut entry, &mut manifest_bytes).map_err(internal)?;
    }
    {
      let mut entry = archive
        .by_name("dopbase.db")
        .map_err(|_| invalid("BACKUP_CORRUPT", "Missing database in backup."))?;
      if entry.size() > MAX_BACKUP_FILE_BYTES as u64 {
        return Err(invalid(
          "BACKUP_FILE_TOO_LARGE",
          "Database payload exceeds the backup size limit.",
        ));
      }
      let mut file = File::create(&path).map_err(internal)?;
      std::io::copy(&mut entry, &mut file).map_err(internal)?;
    }
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
      .map_err(|_| invalid("BACKUP_CORRUPT", "Backup manifest is invalid."))?;
    // Audit records an earlier 0.1.x upgrade set aside. Only names the
    // upgrade writes are taken, so an entry can't point outside the
    // directory, and their total size counts against the backup limit.
    let mut names = Vec::new();
    for name in archive.file_names() {
      let name = name.map_err(|_| invalid("BACKUP_CORRUPT", "Corrupted archive."))?;
      if let Some(rest) = name.strip_prefix(AUDIT_ARCHIVE_ENTRY) {
        names.push(rest.to_owned());
      }
    }
    if names.len() > MAX_AUDIT_ARCHIVE_FILES {
      return Err(invalid(
        "BACKUP_CORRUPT",
        "Backup holds too many audit archive files.",
      ));
    }
    let archive_dir = dir.path().join("audit-archive");
    let mut audit_archives = Vec::new();
    let mut archived_bytes = 0_u64;
    for name in names {
      if !audit_archive_name(&name) {
        return Err(invalid(
          "BACKUP_CORRUPT",
          "Backup holds an unexpected audit archive file.",
        ));
      }
      let mut entry = archive
        .by_name(&format!("{AUDIT_ARCHIVE_ENTRY}{name}"))
        .map_err(|_| invalid("BACKUP_CORRUPT", "Corrupted archive."))?;
      archived_bytes = archived_bytes.saturating_add(entry.size());
      if archived_bytes > MAX_BACKUP_FILE_BYTES as u64 {
        return Err(invalid(
          "BACKUP_FILE_TOO_LARGE",
          "Audit archive payload exceeds the backup size limit.",
        ));
      }
      std::fs::create_dir_all(&archive_dir).map_err(internal)?;
      let target = archive_dir.join(&name);
      let mut file = File::create(&target).map_err(internal)?;
      std::io::copy(&mut entry, &mut file).map_err(internal)?;
      audit_archives.push(target);
    }
    Ok(Unpacked {
      dir,
      db_path: path,
      manifest,
      audit_archives,
    })
  })
  .await
  .map_err(internal)?
}

async fn open(path: &Path) -> Result<DbClient, HttpError> {
  DbClient::connect(&format!("sqlite://{}", path.to_string_lossy()))
    .await
    .map_err(|_| invalid("BACKUP_INVALID_DB", "Invalid SQLite database in backup."))
}

/// `PRAGMA quick_check` and `PRAGMA foreign_key_check` on a prepared copy.
async fn check(connection: &mut SqliteConnection) -> Result<(), HttpError> {
  let corrupt = || invalid("BACKUP_CORRUPT", "Database integrity check failed.");
  let integrity: String = sqlx::query_scalar("PRAGMA quick_check")
    .fetch_one(&mut *connection)
    .await
    .map_err(|_| corrupt())?;
  if integrity != "ok" {
    return Err(corrupt());
  }
  let dangling: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
    .fetch_all(&mut *connection)
    .await
    .map_err(|_| corrupt())?;
  if !dangling.is_empty() {
    tracing::warn!(tables = ?dangling, "backup has rows that point at missing rows");
    return Err(corrupt());
  }
  Ok(())
}

/// Unpacks a decrypted backup and gets its database ready to restore: a
/// 0.1.x backup is upgraded, a 0.2.0 one migrated, both are checked, and
/// the data keys are re-wrapped from `rekey_from` to this server's key
/// when the backup was made elsewhere. Fails without touching the live
/// instance.
pub async fn prepare(
  state: &AppState,
  decrypted: Vec<u8>,
  rekey_from: Option<&[u8]>,
) -> Result<Prepared, HttpError> {
  let Unpacked {
    dir,
    db_path: mut path,
    manifest,
    mut audit_archives,
  } = unpack(decrypted).await?;
  if manifest.magic != MANIFEST_MAGIC && manifest.magic != LEGACY_MANIFEST_MAGIC {
    return Err(invalid(
      "BACKUP_VERSION_UNSUPPORTED",
      "This backup was created by an older Dopbase format and cannot be restored by this release.",
    ));
  }
  let client = open(&path).await?;
  let mut connection = client.pool().acquire().await.map_err(internal)?;
  // The database decides, not the label, so a mislabelled 0.1.x file can't
  // skip the upgrade.
  let found = generation(&mut connection)
    .await
    .map_err(|_| invalid("BACKUP_INVALID_DB", "Invalid SQLite database in backup."))?;
  drop(connection);
  let mut report = None;
  match found {
    Generation::Newer => {
      return Err(invalid(
        "BACKUP_VERSION_NEWER",
        "This backup was made by a newer Dopbase. Restore it with that version or newer.",
      ));
    }
    Generation::Empty => {
      return Err(invalid(
        "BACKUP_INVALID_DB",
        "The backup holds no Dopbase database.",
      ));
    }
    Generation::Legacy => {
      client.close().await;
      let upgraded = dir.path().join("upgraded.db");
      // Set aside next to the copy, not in this server's archive: nothing
      // live changes until a restore applies the backup.
      let archive_dir = dir.path().join("audit-archive");
      let upgraded_report = upgrade::run(&path, &upgraded, &archive_dir).await?;
      if let Some(name) = &upgraded_report.audit_archive {
        audit_archives.push(archive_dir.join(name));
      }
      report = Some(upgraded_report);
      path = upgraded;
    }
    Generation::Current => {
      MIGRATOR.run(client.pool()).await.map_err(|_| {
        invalid(
          "BACKUP_INVALID_DB",
          "Backup database schema cannot be migrated.",
        )
      })?;
      client.close().await;
    }
  }
  let client = open(&path).await?;
  let mut connection = client.pool().acquire().await.map_err(internal)?;
  check(&mut connection).await?;
  drop(connection);
  if let Some(old_key) = rekey_from {
    crate::services::crypto::rekey_database(
      client.pool(),
      old_key,
      &state.crypto.master_key_bytes(),
    )
    .await
    .map_err(|error| {
      tracing::warn!(%error, "re-keying a backup failed");
      rekey_failed()
    })?;
  }
  client.checkpoint().await.map_err(internal)?;
  client.close().await;
  Ok(Prepared {
    _dir: dir,
    path,
    upgrade: report,
    audit_archives,
  })
}

/// A prepared backup as a file for this server's backup folder: a 0.2.0
/// archive encrypted with this server's master key.
pub async fn seal(
  state: &AppState,
  prepared: &Prepared,
  name: &str,
) -> Result<Vec<u8>, HttpError> {
  seal_file(
    state,
    prepared.path.clone(),
    name.to_owned(),
    prepared.audit_archives.clone(),
  )
  .await
}

/// The signed-in administrator a restore keeps: their account and session
/// survive the restore, and the `backup.restored` record names them.
#[derive(Clone, Copy, Debug)]
pub struct PreservedAdmin<'a> {
  pub admin_id: &'a str,
  pub email: &'a str,
  pub session_id: &'a str,
  /// The actor type the `backup.restored` record stores.
  pub actor_type: &'a str,
}

/// How one table comes back. `filter` and `columns` may use `src` for the
/// backup's row, `temp.restore_users` for the accounts that will exist
/// after the restore, and `temp.restore_revoked` for tokens the live
/// instance had revoked.
struct TablePolicy {
  table: &'static str,
  /// `None`: the table is not restored at all.
  filter: Option<&'static str>,
  columns: &'static [(&'static str, &'static str)],
}

/// A reference to an account that may not survive the restore: it becomes
/// NULL, as `ON DELETE SET NULL` would make it.
macro_rules! kept_or_null {
  ($column:literal) => {
    concat!(
      "CASE WHEN src.",
      $column,
      " IN (SELECT id FROM temp.restore_users) THEN src.",
      $column,
      " END"
    )
  };
}

/// A token revoked on the live instance stays revoked, even when the backup
/// predates the revocation.
const KEEP_REVOCATION: &str =
  "COALESCE(src.revoked_at, (SELECT r.revoked_at FROM temp.restore_revoked r WHERE r.id = src.id))";

/// What restore does with each table in [`INSTANCE_TABLES`].
fn policy(table: &str) -> TablePolicy {
  let (filter, columns): (
    Option<&'static str>,
    &'static [(&'static str, &'static str)],
  ) = match table {
    // Built-in roles come from the baseline and stay.
    "roles" => (Some("src.builtin = 0"), &[]),
    "role_capabilities" => (
      Some("src.role_id IN (SELECT id FROM backup_db.roles WHERE builtin = 0)"),
      &[],
    ),
    "accounts" => (
      Some(
        "src.id IN (SELECT id FROM temp.restore_users) AND src.id NOT IN (SELECT id FROM main.accounts)",
      ),
      &[
        ("created_by", kept_or_null!("created_by")),
        ("disabled_by", kept_or_null!("disabled_by")),
      ],
    ),
    "users" => (
      Some(
        "src.id IN (SELECT id FROM temp.restore_users) AND src.id NOT IN (SELECT id FROM main.users)",
      ),
      &[],
    ),
    "agents" => (
      Some("src.id IN (SELECT id FROM temp.restore_users)"),
      // An AI agent whose owner is gone moves to the root that stays.
      &[(
        "owner_id",
        "CASE WHEN src.owner_id IN (SELECT id FROM temp.restore_users) THEN src.owner_id ELSE (SELECT id FROM main.accounts WHERE is_root = 1) END",
      )],
    ),
    // Everyone signs in again; only the restoring admin's session stays.
    // Sign-in flows and passcodes last minutes and aren't kept either.
    "sessions" | "sso_flows" | "cli_device_requests" | "passcodes" => (None, &[]),
    "user_identities" => (
      Some("src.user_id IN (SELECT id FROM temp.restore_users)"),
      &[],
    ),
    "runner_tokens" => (
      Some("TRUE"),
      &[
        (
          "created_by",
          "CASE WHEN src.created_by IS NULL OR src.created_by IN (SELECT id FROM temp.restore_users) THEN src.created_by ELSE (SELECT id FROM main.accounts WHERE is_root = 1) END",
        ),
        ("revoked_at", KEEP_REVOCATION),
      ],
    ),
    "personal_tokens" => (
      Some("src.account_id IN (SELECT id FROM temp.restore_users)"),
      &[
        ("created_by", kept_or_null!("created_by")),
        ("revoked_at", KEEP_REVOCATION),
      ],
    ),
    "groups" => (Some("TRUE"), &[("created_by", kept_or_null!("created_by"))]),
    "group_members" => (
      Some("src.account_id IN (SELECT id FROM temp.restore_users)"),
      &[("added_by", kept_or_null!("added_by"))],
    ),
    "grants" => (
      Some("src.account_id IS NULL OR src.account_id IN (SELECT id FROM temp.restore_users)"),
      &[("granted_by", kept_or_null!("granted_by"))],
    ),
    _ => (Some("TRUE"), &[]),
  };
  TablePolicy {
    table: INSTANCE_TABLES
      .iter()
      .find(|known| **known == table)
      .copied()
      .unwrap_or("unknown"),
    filter,
    columns,
  }
}

/// The columns of a live table, in order. Copies name every column, so
/// they never depend on two databases agreeing on column order.
async fn columns_of(
  connection: &mut SqliteConnection,
  table: &str,
) -> Result<Vec<String>, sqlx::Error> {
  sqlx::query_scalar(&format!(
    "SELECT name FROM pragma_table_info('{table}', 'main') ORDER BY cid"
  ))
  .fetch_all(connection)
  .await
}

async fn copy_table(
  connection: &mut SqliteConnection,
  policy: &TablePolicy,
) -> anyhow::Result<()> {
  let Some(filter) = policy.filter else {
    return Ok(());
  };
  let columns = columns_of(&mut *connection, policy.table).await?;
  let selected: Vec<String> = columns
    .iter()
    .map(|column| {
      policy
        .columns
        .iter()
        .find(|(name, _)| name == column)
        .map_or_else(
          || format!("src.{column}"),
          |(_, expression)| (*expression).to_owned(),
        )
    })
    .collect();
  let table = policy.table;
  sqlx::query(&format!(
    "INSERT INTO main.{table} ({}) SELECT {} FROM backup_db.{table} src WHERE {filter}",
    columns.join(", "),
    selected.join(", "),
  ))
  .execute(&mut *connection)
  .await
  .with_context(|| format!("failed to restore {table}"))?;
  Ok(())
}

/// Copies a row the restore keeps from a temp table back into its live
/// table, every column by name.
async fn put_back(
  connection: &mut SqliteConnection,
  table: &str,
  saved: &str,
) -> anyhow::Result<()> {
  let columns = columns_of(&mut *connection, table).await?.join(", ");
  sqlx::query(&format!(
    "INSERT INTO main.{table} ({columns}) SELECT {columns} FROM temp.{saved}"
  ))
  .execute(&mut *connection)
  .await
  .with_context(|| format!("failed to keep the current {table}"))?;
  Ok(())
}

/// Copies the prepared audit archive files into `archive_dir`. A file of the
/// same name holds the same records (it is named after the first and last
/// one), so it is replaced.
async fn write_audit_archives(
  archive_dir: &Path,
  files: &[PathBuf],
) -> anyhow::Result<()> {
  if files.is_empty() {
    return Ok(());
  }
  let archive_dir = archive_dir.to_owned();
  let files = files.to_vec();
  tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
    std::fs::create_dir_all(&archive_dir)?;
    for file in files {
      let name = file.file_name().context("audit archive file has no name")?;
      crate::utils::private_file::write(&archive_dir.join(name), &std::fs::read(&file)?, true)?;
    }
    Ok(())
  })
  .await?
}

/// What the `backup.restored` record says about a restore.
pub struct RestoreRecord<'a> {
  pub key: &'a str,
  /// Extra fields for the record's metadata.
  pub details: serde_json::Value,
}

/// Replaces the live instance's data with a prepared backup's, in one
/// transaction. With `preserve`, that administrator's account and session
/// survive and the backup's root is left out; the `backup.restored` record
/// names them. Without it (restore during setup) every account comes back
/// and the caller records the event.
pub async fn apply(
  state: &AppState,
  prepared: &Prepared,
  preserve: Option<PreservedAdmin<'_>>,
  record: RestoreRecord<'_>,
) -> Result<(), HttpError> {
  // A disposable pool: dropping it on cancellation keeps the ATTACH off
  // the live request pool.
  let restore_db = DbClient::connect(&state.config.database_url)
    .await
    .map_err(internal)?;
  let mut conn = restore_db.pool().acquire().await.map_err(internal)?;
  let escaped = prepared.path.to_string_lossy().replace('\'', "''");
  sqlx::query(&format!("ATTACH DATABASE '{escaped}' AS backup_db"))
    .execute(&mut *conn)
    .await
    .map_err(internal)?;

  let result = async {
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    for statement in [
      "DROP TABLE IF EXISTS temp.preserved_account",
      "DROP TABLE IF EXISTS temp.preserved_user",
      "DROP TABLE IF EXISTS temp.preserved_session",
      "DROP TABLE IF EXISTS temp.restore_users",
      "DROP TABLE IF EXISTS temp.restore_revoked",
      "CREATE TEMP TABLE restore_revoked AS SELECT id, revoked_at FROM main.runner_tokens WHERE revoked_at IS NOT NULL UNION ALL SELECT id, revoked_at FROM main.personal_tokens WHERE revoked_at IS NOT NULL",
    ] {
      sqlx::query(statement).execute(&mut *tx).await?;
    }
    // The account and session that stay, every column of them, so a column
    // added later can't be lost.
    sqlx::query("CREATE TEMP TABLE preserved_account AS SELECT * FROM main.accounts WHERE id = $1")
      .bind(preserve.map(|admin| admin.admin_id))
      .execute(&mut *tx)
      .await?;
    sqlx::query("CREATE TEMP TABLE preserved_user AS SELECT * FROM main.users WHERE id = $1")
      .bind(preserve.map(|admin| admin.admin_id))
      .execute(&mut *tx)
      .await?;
    sqlx::query("CREATE TEMP TABLE preserved_session AS SELECT * FROM main.sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL")
      .bind(preserve.map(|admin| admin.session_id))
      .bind(preserve.map(|admin| admin.admin_id))
      .execute(&mut *tx)
      .await?;
    // Accounts that exist once the restore is done. When an admin is kept,
    // the backup's root and any account with that admin's email give way.
    match preserve {
      Some(admin) => {
        sqlx::query("CREATE TEMP TABLE restore_users AS SELECT a.id FROM backup_db.accounts a LEFT JOIN backup_db.users u ON u.id = a.id WHERE a.is_root = 0 AND (u.email IS NULL OR lower(u.email) <> lower($1)) UNION SELECT id FROM temp.preserved_account")
          .bind(admin.email)
          .execute(&mut *tx)
          .await?;
      }
      None => {
        sqlx::query("CREATE TEMP TABLE restore_users AS SELECT id FROM backup_db.accounts")
          .execute(&mut *tx)
          .await?;
      }
    }

    // The restore replaces the audit log with the snapshot's, which would
    // erase everything written since the snapshot. Keep it on disk first;
    // without that copy the restore does not go ahead.
    let archived = crate::services::audit_chain::archive_all(
      &mut tx,
      &state.config.data_dir.join(AUDIT_ARCHIVE_DIRECTORY_NAME),
    )
    .await
    .context("failed to archive the audit log before restoring")?;
    // Audit records a 0.1.x upgrade set aside join this server's archive
    // now, before anything is replaced, as the live log just did.
    write_audit_archives(
      &state.config.data_dir.join(AUDIT_ARCHIVE_DIRECTORY_NAME),
      &prepared.audit_archives,
    )
    .await
    .context("failed to keep the backup's archived audit records")?;

    crate::services::instance_tables::wipe(&mut tx).await?;
    sqlx::query("DELETE FROM main.instance_metadata")
      .execute(&mut *tx)
      .await?;
    // The backup was re-keyed to this server's key, so its key check holds.
    sqlx::query("INSERT INTO main.instance_metadata (id, verification_ciphertext, verification_nonce, created_at) SELECT id, verification_ciphertext, verification_nonce, created_at FROM backup_db.instance_metadata")
      .execute(&mut *tx)
      .await?;

    for table in INSTANCE_TABLES {
      // The kept admin goes in first, so accounts that point at the root
      // can find it.
      if table == "accounts" {
        put_back(&mut tx, "accounts", "preserved_account").await?;
      }
      if table == "users" {
        put_back(&mut tx, "users", "preserved_user").await?;
      }
      copy_table(&mut tx, &policy(table)).await?;
      if table == "sessions" {
        put_back(&mut tx, "sessions", "preserved_session").await?;
      }
    }

    let dangling: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
      .fetch_all(&mut *tx)
      .await?;
    if !dangling.is_empty() {
      anyhow::bail!("restored rows point at missing rows in {dangling:?}");
    }

    if let Some(admin) = preserve {
      let mut metadata = serde_json::json!({
        "backup": record.key,
        "previousHead": archived.head.as_ref().map(|(seq, hash)| serde_json::json!({"seq": seq, "hash": hash})),
        "archivedRecords": archived.records,
        "archive": archived.archive,
      });
      if let (Some(fields), Some(extra)) = (metadata.as_object_mut(), record.details.as_object()) {
        fields.extend(extra.clone());
      }
      common::audit(
        &mut tx,
        admin.actor_type,
        Some(admin.admin_id),
        Some(admin.email),
        crate::services::events::Action::BackupRestored,
        None,
        None,
        Some("backup"),
        Some(record.key),
        metadata,
      )
      .await?;
    }
    tx.commit().await?;
    Ok::<(), anyhow::Error>(())
  }
  .await;

  for statement in [
    "DROP TABLE IF EXISTS temp.preserved_user",
    "DROP TABLE IF EXISTS temp.preserved_session",
    "DROP TABLE IF EXISTS temp.restore_users",
    "DROP TABLE IF EXISTS temp.restore_revoked",
    "DETACH DATABASE backup_db",
  ] {
    let _ = sqlx::query(statement).execute(&mut *conn).await;
  }
  drop(conn);
  restore_db.close().await;
  result.map_err(|error| {
    tracing::error!(
      error = format!("{error:#}"),
      "failed to apply backup restore"
    );
    HttpError::internal()
  })?;

  // Sign-in providers may have changed; drop what was cached about them.
  state.oidc.clear().await;

  // Best-effort scrub: the wiped rows must not linger in the live database
  // file or WAL after the restore replaced them.
  if let Err(error) = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
    .execute(state.db.pool())
    .await
  {
    tracing::warn!(%error, "failed to checkpoint WAL after backup restore");
  }
  if let Err(error) = sqlx::query("VACUUM").execute(state.db.pool()).await {
    tracing::warn!(%error, "failed to vacuum after backup restore");
  }
  Ok(())
}
