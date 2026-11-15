//! The secret store: the rules of one environment's collection of secrets,
//! in one place. Every write that sets a value goes through [`put`], which
//! numbers the version (the current one plus one), keeps the key's first
//! creation time, binds the ciphertext to that version, and applies the
//! history retention. Every write that adds keys or bytes asks
//! [`require_room`] first, so the per-environment limits hold whichever
//! page or command the write came from.
//!
//! Callers check access and record events; the store does neither.

use std::collections::HashMap;

use chrono::Utc;
use sqlx::SqliteConnection;

use super::{
  model::SecretMetadata,
  repository::{self, ChangeType, NewVersion, VersionActor},
};
use crate::{
  constants::{
    errors::{SECRET_COUNT_LIMIT_MESSAGE, SECRET_LIMIT_EXCEEDED, SECRET_TOTAL_SIZE_LIMIT_MESSAGE},
    limits::{MAX_SECRET_COLLECTION_BYTES, MAX_SECRETS_PER_ENVIRONMENT},
  },
  http::HttpError,
  services::crypto::VALUE_TAG_BYTES,
  state::AppState,
  utils::time::Stamp,
};

pub fn count_limit() -> HttpError {
  HttpError::new(
    axum::http::StatusCode::UNPROCESSABLE_ENTITY,
    SECRET_LIMIT_EXCEEDED,
    SECRET_COUNT_LIMIT_MESSAGE,
  )
}

pub fn size_limit() -> HttpError {
  HttpError::new(
    axum::http::StatusCode::UNPROCESSABLE_ENTITY,
    SECRET_LIMIT_EXCEEDED,
    SECRET_TOTAL_SIZE_LIMIT_MESSAGE,
  )
}

/// Checks the environment stays within its limits once `writes` are stored
/// (key and value length; a key already there is replaced) and `removes`
/// are deleted. Run it on the write transaction, before writing.
pub async fn require_room(
  conn: &mut SqliteConnection,
  environment_id: &str,
  writes: &[(&str, usize)],
  removes: &[&str],
) -> Result<(), HttpError> {
  // The writes as they will land: a key written twice keeps its last size.
  let written: HashMap<&str, usize> = writes.iter().copied().collect();
  // Every other key is counted and summed in SQL, so one row comes back
  // however many secrets the environment holds. Sizes come from the
  // ciphertext lengths, so nothing is decrypted.
  let touched: Vec<&str> = written
    .keys()
    .copied()
    .chain(removes.iter().copied())
    .collect();
  let excluded = if touched.is_empty() {
    String::new()
  } else {
    let placeholders = (0..touched.len())
      .map(|index| format!("${}", index + 3))
      .collect::<Vec<_>>()
      .join(",");
    format!(" AND s.key NOT IN ({placeholders})")
  };
  let sql = format!(
    "SELECT COUNT(*), CAST(COALESCE(SUM(octet_length(v.ciphertext) - $2), 0) AS BIGINT) FROM secrets s JOIN secret_versions v ON v.environment_id = s.environment_id AND v.key = s.key AND v.version = s.current_version WHERE s.environment_id = $1{excluded}"
  );
  let mut query = sqlx::query_as::<_, (i64, i64)>(&sql)
    .bind(environment_id)
    .bind(VALUE_TAG_BYTES);
  for key in &touched {
    query = query.bind(*key);
  }
  let (others, other_bytes) = query.fetch_one(&mut *conn).await?;
  let count = usize::try_from(others).unwrap_or_default() + written.len();
  let bytes = usize::try_from(other_bytes).unwrap_or_default() + written.values().sum::<usize>();
  if count > MAX_SECRETS_PER_ENVIRONMENT {
    return Err(count_limit());
  }
  if bytes > MAX_SECRET_COLLECTION_BYTES {
    return Err(size_limit());
  }
  Ok(())
}

/// A key's current version and first creation time, on the caller's write
/// transaction.
pub async fn current(
  conn: &mut SqliteConnection,
  environment_id: &str,
  key: &str,
) -> Result<Option<(i64, String)>, HttpError> {
  Ok(
    sqlx::query_as(
      "SELECT current_version, created_at FROM secrets WHERE environment_id = $1 AND key = $2",
    )
    .bind(environment_id)
    .bind(key)
    .fetch_optional(conn)
    .await?,
  )
}

/// Who wrote a version, as its history row names them.
#[derive(Clone, Copy)]
pub struct Writer<'a> {
  pub actor_type: &'a str,
  pub actor_id: &'a str,
  pub label: &'a str,
}

/// Stores `value` as the next version of `key`, after `current` (from
/// [`current`]). The version number is the current one plus one, and the
/// ciphertext is bound to it.
#[allow(clippy::too_many_arguments)]
pub async fn put(
  state: &AppState,
  conn: &mut SqliteConnection,
  writer: Writer<'_>,
  environment_id: &str,
  key: &str,
  value: &str,
  current: Option<(i64, String)>,
  change: Option<ChangeType>,
) -> Result<SecretMetadata, HttpError> {
  let version = current.as_ref().map_or(1, |(version, _)| version + 1);
  let now = Utc::now().stamp();
  let created_at = current
    .as_ref()
    .map_or_else(|| now.clone(), |(_, created_at)| created_at.clone());
  let encrypted = state
    .crypto
    .encrypt(value.as_bytes(), environment_id, key, version)
    .map_err(|_| HttpError::internal())?;
  let change = change.unwrap_or(if current.is_some() {
    ChangeType::Updated
  } else {
    ChangeType::Created
  });
  repository::write_version(
    conn,
    NewVersion {
      environment_id,
      key,
      version,
      encrypted,
      created_at: &created_at,
      now: &now,
      change,
      source_version: None,
      actor: VersionActor {
        actor_type: writer.actor_type,
        actor_id: Some(writer.actor_id),
        actor_label: Some(writer.label),
      },
      keep: state.config.secret_history_versions,
    },
  )
  .await?;
  Ok(SecretMetadata {
    key: key.into(),
    version,
    created_at,
    updated_at: now,
  })
}
