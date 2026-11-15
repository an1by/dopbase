use crate::utils::time::Stamp;
use std::{fs, path::PathBuf, sync::OnceLock};

use chrono::Utc;
use regex::Regex;

use super::model::*;
use crate::{
  extractors::{require_capability, require_recent_auth},
  http::HttpError,
  models::AuthIdentity,
  modules::common,
  services::authx::Capability,
  state::AppState,
  utils::private_file,
};

const BACKUP_DIR_NAME: &str = "backups";
const BACKUP_EXTENSION: &str = ".dop";
pub use super::snapshot::PreservedAdmin;
use super::{snapshot, upgrade::UpgradeReport};

pub fn backup_dir(state: &AppState) -> PathBuf {
  let dir = state.config.data_dir.join(BACKUP_DIR_NAME);
  if !dir.exists() {
    let _ = fs::create_dir_all(&dir);
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
  }
  dir
}

pub fn sanitize_key(key: &str) -> Result<String, HttpError> {
  static KEY_REGEX: OnceLock<Regex> = OnceLock::new();
  let regex = KEY_REGEX.get_or_init(|| Regex::new(r"^[a-zA-Z0-9_-]+\.dop$").unwrap());

  if !regex.is_match(key) || key.contains("..") || key.contains('/') || key.contains('\\') {
    return Err(HttpError::bad_request(
      "BACKUP_KEY_INVALID",
      "Backup key is invalid.",
    ));
  }
  Ok(key.to_string())
}

pub fn sanitize_name(name: &str) -> Result<String, HttpError> {
  static NAME_REGEX: OnceLock<Regex> = OnceLock::new();
  let regex = NAME_REGEX.get_or_init(|| Regex::new(r"^[a-zA-Z0-9_-]+$").unwrap());

  let trimmed = name.trim();
  let base = trimmed.strip_suffix(BACKUP_EXTENSION).unwrap_or(trimmed);
  if base.is_empty() || base.len() > 64 || !regex.is_match(base) {
    return Err(HttpError::bad_request(
      "BACKUP_NAME_INVALID",
      "Backup name must only contain alphanumeric characters, dashes, and underscores.",
    ));
  }
  Ok(base.to_string())
}

pub async fn list(
  state: &AppState,
  identity: &AuthIdentity,
) -> Result<Vec<BackupItem>, HttpError> {
  require_capability(identity, Capability::InstanceBackup)?;
  let dir = backup_dir(state);
  let mut items = Vec::new();

  if let Ok(entries) = fs::read_dir(&dir) {
    for entry in entries.flatten() {
      let path = entry.path();
      if path.is_file()
        && path
          .extension()
          .and_then(|ext| ext.to_str())
          .is_some_and(|ext| ext == "dop")
      {
        let key = entry.file_name().to_string_lossy().to_string();
        if sanitize_key(&key).is_err() {
          continue;
        }
        if let Ok(meta) = entry.metadata() {
          let size = meta.len();
          let created_at = meta
            .modified()
            .or_else(|_| meta.created())
            .map(|t| chrono::DateTime::<Utc>::from(t).stamp())
            .unwrap_or_else(|_| Utc::now().stamp());
          items.push(BackupItem {
            key,
            size,
            created_at,
            upgrade: None,
          });
        }
      }
    }
  }

  // Sort descending by created_at (newest first)
  items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
  Ok(items)
}

pub async fn create(
  state: &AppState,
  identity: &AuthIdentity,
  request: CreateBackupRequest,
) -> Result<BackupItem, HttpError> {
  let (admin_id, email) = require_capability(identity, Capability::InstanceBackup)?;
  let dir = backup_dir(state);

  let key = if let Some(raw_name) = request.name.filter(|n| !n.trim().is_empty()) {
    let base = sanitize_name(&raw_name)?;
    format!("{base}.dop")
  } else {
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    format!("dopbase_backup_{timestamp}.dop")
  };

  let file_path = dir.join(&key);
  if file_path.exists() {
    return Err(HttpError::conflict(
      "BACKUP_EXISTS",
      "A backup with this name already exists.",
    ));
  }

  let encrypted = snapshot::create(state, &key).await?;

  // Atomically write file
  private_file::write(&file_path, &encrypted, false).map_err(|error| {
    tracing::error!(%error, "failed to write backup file");
    HttpError::internal()
  })?;

  let size = encrypted.len() as u64;
  let created_at = Utc::now().stamp();

  // A backup nobody can see being made doesn't stay.
  if let Err(error) = common::audit_standalone(
    state.db.pool(),
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::BackupCreated,
    None,
    None,
    Some("backup"),
    Some(&key),
    serde_json::json!({ "key": key, "size": size }),
  )
  .await
  {
    let _ = fs::remove_file(&file_path);
    return Err(error.into());
  }

  Ok(BackupItem {
    key,
    size,
    created_at,
    upgrade: None,
  })
}

pub async fn read_for_download(
  state: &AppState,
  identity: &AuthIdentity,
  key: &str,
) -> Result<(PathBuf, u64), HttpError> {
  let (admin_id, email) = require_capability(identity, Capability::InstanceBackup)?;
  let safe_key = sanitize_key(key)?;
  let file_path = backup_dir(state).join(&safe_key);

  if !file_path.exists() {
    return Err(HttpError::not_found(
      "BACKUP_NOT_FOUND",
      "The requested backup was not found.",
    ));
  }

  let size = fs::metadata(&file_path)
    .map_err(|_| HttpError::internal())?
    .len();

  // Handing out a backup is refused when it can't be recorded.
  common::audit_standalone(
    state.db.pool(),
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::BackupDownloaded,
    None,
    None,
    Some("backup"),
    Some(&safe_key),
    serde_json::json!({ "key": safe_key, "size": size }),
  )
  .await?;

  Ok((file_path, size))
}

pub async fn upload(
  state: &AppState,
  identity: &AuthIdentity,
  file_name: &str,
  bytes: Vec<u8>,
  provided_master_key: Option<&[u8]>,
) -> Result<BackupItem, HttpError> {
  let (admin_id, email) = require_capability(identity, Capability::InstanceBackup)?;

  if bytes.len() > snapshot::MAX_BACKUP_FILE_BYTES {
    return Err(HttpError::bad_request(
      "BACKUP_FILE_TOO_LARGE",
      "Backup file exceeds the 250 MB limit.",
    ));
  }

  // 1. Try decrypting with current system master key first.
  // 1. Try decrypting with this server's master key, then the given one.
  let opened = match snapshot::open_file(state, bytes, provided_master_key).await? {
    Ok(opened) => opened,
    Err(snapshot::Unopened::WrongKey) => {
      tracing::warn!("uploaded backup verification failed with provided key");
      return Err(HttpError::bad_request(
        "BACKUP_INVALID",
        "Backup could not be decrypted or authenticated with the provided master key.",
      ));
    }
    Err(snapshot::Unopened::KeyRequired) => {
      return Err(HttpError::bad_request(
        "BACKUP_KEY_REQUIRED",
        "This backup was created on a different server or with a different master key. Please provide the master key from that server to import it.",
      ));
    }
  };
  let needs_rekey = opened.rekey_from.is_some();

  // 2. Check it the way a restore would: unpack, upgrade a 0.1.x backup,
  // migrate, check integrity, and re-key it to this server. A backup that
  // needed none of that is kept byte for byte.
  let prepared = snapshot::prepare(state, opened.archive, opened.rekey_from.as_deref()).await?;
  let upgrade = prepared.upgrade.clone();
  let final_bytes = if needs_rekey || upgrade.is_some() {
    snapshot::seal(state, &prepared, file_name).await?
  } else {
    opened.file
  };
  drop(prepared);

  let dir = backup_dir(state);
  let base_name = file_name
    .strip_suffix(BACKUP_EXTENSION)
    .unwrap_or(file_name);
  let safe_base = sanitize_name(base_name).unwrap_or_else(|_| {
    let timestamp = Utc::now().format("%Y%m%d_%H%M%S");
    format!("uploaded_backup_{timestamp}")
  });

  let mut target_key = format!("{safe_base}.dop");
  let mut counter = 1;
  while dir.join(&target_key).exists() {
    target_key = format!("{safe_base}_{counter}.dop");
    counter += 1;
  }

  let target_path = dir.join(&target_key);
  private_file::write(&target_path, &final_bytes, false).map_err(|error| {
    tracing::error!(%error, "failed to save uploaded backup");
    HttpError::internal()
  })?;

  let size = final_bytes.len() as u64;
  let created_at = Utc::now().stamp();

  let recorded = common::audit_standalone(
    state.db.pool(),
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::BackupUploaded,
    None,
    None,
    Some("backup"),
    Some(&target_key),
    serde_json::json!({
      "key": target_key,
      "size": size,
      "rekeyed": needs_rekey,
      "upgradedFrom": upgrade.as_ref().map(|report| report.upgraded_from.as_str()),
    }),
  )
  .await;
  if let Err(error) = recorded {
    let _ = fs::remove_file(&target_path);
    return Err(error.into());
  }

  Ok(BackupItem {
    key: target_key,
    size,
    created_at,
    upgrade,
  })
}

pub async fn restore(
  state: &AppState,
  identity: &AuthIdentity,
  key: &str,
  provided_master_key: Option<&[u8]>,
) -> Result<Option<UpgradeReport>, HttpError> {
  require_recent_auth(identity)?;
  let (admin_id, email) = require_capability(identity, Capability::InstanceBackup)?;
  let safe_key = sanitize_key(key)?;
  let file_path = backup_dir(state).join(&safe_key);

  if !file_path.exists() {
    return Err(HttpError::not_found(
      "BACKUP_NOT_FOUND",
      "The requested backup was not found.",
    ));
  }

  let encrypted = tokio::fs::read(&file_path)
    .await
    .map_err(|_| HttpError::internal())?;
  let opened = match snapshot::open_file(state, encrypted, provided_master_key).await? {
    Ok(opened) => opened,
    Err(snapshot::Unopened::WrongKey) => {
      return Err(HttpError::bad_request(
        "BACKUP_DECRYPT_FAILED",
        "Failed to decrypt backup with the provided master key.",
      ));
    }
    Err(snapshot::Unopened::KeyRequired) => {
      return Err(HttpError::bad_request(
        "BACKUP_DECRYPT_FAILED",
        "Failed to decrypt backup. Ensure you provided the correct master key for this backup.",
      ));
    }
  };

  let prepared = snapshot::prepare(state, opened.archive, opened.rekey_from.as_deref()).await?;
  let details = match &prepared.upgrade {
    Some(report) => serde_json::json!({
      "upgradedFrom": report.upgraded_from,
      "upgrade": report,
    }),
    None => serde_json::json!({}),
  };
  snapshot::apply(
    state,
    &prepared,
    Some(PreservedAdmin {
      admin_id,
      email,
      session_id: session_id_from_identity(identity),
      actor_type: identity.audit_actor_type(),
    }),
    snapshot::RestoreRecord {
      key: &safe_key,
      details,
    },
  )
  .await?;
  Ok(prepared.upgrade.clone())
}

fn session_id_from_identity(identity: &AuthIdentity) -> &str {
  match identity {
    AuthIdentity::Admin { session_id, .. } => session_id,
    AuthIdentity::Runner { .. } => "",
    AuthIdentity::Token { .. } => "",
  }
}

pub async fn delete(
  state: &AppState,
  identity: &AuthIdentity,
  key: &str,
) -> Result<(), HttpError> {
  let (admin_id, email) = require_capability(identity, Capability::InstanceBackup)?;
  let safe_key = sanitize_key(key)?;
  let file_path = backup_dir(state).join(&safe_key);

  if !file_path.exists() {
    return Err(HttpError::not_found(
      "BACKUP_NOT_FOUND",
      "The requested backup was not found.",
    ));
  }

  fs::remove_file(&file_path).map_err(|error| {
    tracing::error!(%error, "failed to delete backup file");
    HttpError::internal()
  })?;

  common::audit_standalone(
    state.db.pool(),
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    crate::services::events::Action::BackupDeleted,
    None,
    None,
    Some("backup"),
    Some(&safe_key),
    serde_json::json!({ "key": safe_key }),
  )
  .await?;

  Ok(())
}
