use std::{
  collections::BTreeMap,
  sync::{Arc, OnceLock},
};

use argon2::{
  Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version,
  password_hash::{SaltString, rand_core::OsRng},
};
use regex::Regex;
use serde_json::Value;

use crate::{
  constants::errors::{EMAIL_INVALID, EMAIL_INVALID_MESSAGE},
  http::HttpError,
  services::{audit_chain::AuditEntry, token},
};

pub fn validate_slug(
  value: &str,
  code: &str,
  label: &str,
) -> Result<(), HttpError> {
  if !crate::utils::slug::is_valid(value) {
    return Err(HttpError::validation(BTreeMap::from([(
      code.into(),
      format!("{label} must be a lowercase slug of at most 63 characters."),
    )])));
  }
  Ok(())
}

pub fn validate_email(value: &str) -> Result<String, HttpError> {
  static EMAIL: OnceLock<Regex> = OnceLock::new();
  let normalized = value.trim().to_lowercase();
  let valid = EMAIL.get_or_init(|| Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").unwrap());
  if normalized.len() > 254 || !valid.is_match(&normalized) {
    return Err(HttpError::validation(BTreeMap::from([(
      EMAIL_INVALID.into(),
      EMAIL_INVALID_MESSAGE.into(),
    )])));
  }
  Ok(normalized)
}

pub fn validate_password(value: &str) -> Result<(), HttpError> {
  let length = value.chars().count();
  let mut errors = BTreeMap::new();
  if length < 12 {
    errors.insert(
      "PASSWORD_TOO_SHORT".into(),
      "Password must contain at least 12 characters.".into(),
    );
  }
  if length > 128 {
    errors.insert(
      "PASSWORD_TOO_LONG".into(),
      "Password must contain at most 128 characters.".into(),
    );
  }
  if errors.is_empty() {
    Ok(())
  } else {
    Err(HttpError::validation(errors))
  }
}

/// Stored as the password hash of an account that signs in only through
/// single sign-on. It is not a valid hash, so it matches no password. The
/// column stays NOT NULL because SQLite relaxes that only by rebuilding the
/// table, and inside the transaction sqlx wraps every migration in, the
/// rebuild would cascade-delete sessions.
pub const NO_PASSWORD_HASH: &str = "";

pub fn has_password(encoded: &str) -> bool {
  !encoded.is_empty()
}

/// A real hash to verify against when an account is missing or has no
/// password, so a failed login takes as long either way and its timing
/// does not reveal which emails have accounts or passwords.
fn dummy_hash() -> &'static str {
  static HASH: OnceLock<String> = OnceLock::new();
  HASH.get_or_init(|| hash_password("dopbase-timing-equalizer").unwrap_or_default())
}

/// Verify `value` against `encoded`, or against a dummy hash when there is
/// nothing to verify, which always fails.
pub async fn verify_password_or_dummy(
  value: String,
  encoded: Option<String>,
) -> Result<bool, HttpError> {
  match encoded.filter(|encoded| has_password(encoded)) {
    Some(encoded) => verify_password_async(value, encoded).await,
    None => {
      let _ = verify_password_async(value, dummy_hash().to_owned()).await?;
      Ok(false)
    }
  }
}

pub fn hash_password(value: &str) -> Result<String, HttpError> {
  let params = Params::new(19_456, 2, 1, None).map_err(|_| HttpError::internal())?;
  let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
  let salt = SaltString::generate(&mut OsRng);
  argon
    .hash_password(value.as_bytes(), &salt)
    .map(|hash| hash.to_string())
    .map_err(|_| HttpError::internal())
}

pub fn verify_password(
  value: &str,
  encoded: &str,
) -> bool {
  PasswordHash::new(encoded).ok().is_some_and(|hash| {
    Argon2::default()
      .verify_password(value.as_bytes(), &hash)
      .is_ok()
  })
}

fn password_workers() -> &'static Arc<tokio::sync::Semaphore> {
  static WORKERS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
  WORKERS.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
}

pub async fn hash_password_async(value: String) -> Result<String, HttpError> {
  let value = zeroize::Zeroizing::new(value);
  let permit = password_workers()
    .clone()
    .acquire_owned()
    .await
    .map_err(|_| HttpError::internal())?;
  tokio::task::spawn_blocking(move || {
    let _permit = permit;
    hash_password(&value)
  })
  .await
  .map_err(|error| {
    tracing::error!(%error, "password hashing worker failed");
    HttpError::internal()
  })?
}

pub async fn verify_password_async(
  value: String,
  encoded: String,
) -> Result<bool, HttpError> {
  let permit = password_workers()
    .clone()
    .acquire_owned()
    .await
    .map_err(|_| HttpError::internal())?;
  tokio::task::spawn_blocking(move || {
    let _permit = permit;
    verify_password(&value, &encoded)
  })
  .await
  .map_err(|error| {
    tracing::error!(%error, "password verification worker failed");
    HttpError::internal()
  })
}

/// Record an audit event on the caller's connection.
///
/// The record joins the tamper-evident hash chain, which reads the chain head
/// before inserting. The connection must therefore already hold SQLite's
/// write lock: pass an immediate transaction, or a transaction whose first
/// statement was a write. Every business transaction that audits already
/// writes first, and [`audit_standalone`] handles the remaining cases.
///
/// The client IP comes from the current request, when there is one.
#[allow(clippy::too_many_arguments)]
pub async fn audit(
  connection: &mut sqlx::SqliteConnection,
  actor_type: &str,
  actor_id: Option<&str>,
  actor_label: Option<&str>,
  action: &str,
  project_id: Option<&str>,
  environment_id: Option<&str>,
  resource_type: Option<&str>,
  resource_id: Option<&str>,
  metadata: Value,
) -> Result<(), sqlx::Error> {
  let metadata = metadata.to_string();
  let created_at = chrono::Utc::now().to_rfc3339();
  let ip_address = crate::services::client_ip::current().map(|address| address.to_string());
  crate::services::audit_chain::append(
    connection,
    &AuditEntry {
      id: &token::public_id("aud_"),
      actor_type,
      actor_id,
      actor_label,
      action,
      project_id,
      environment_id,
      resource_type,
      resource_id,
      ip_address: ip_address.as_deref(),
      metadata: &metadata,
      created_at: &created_at,
    },
  )
  .await
}

/// Record an audit event in its own committed transaction.
///
/// For actions that have no business transaction to join, so the record is
/// durable on its own and the chain append stays atomic.
#[allow(clippy::too_many_arguments)]
pub async fn audit_standalone(
  pool: &sqlx::SqlitePool,
  actor_type: &str,
  actor_id: Option<&str>,
  actor_label: Option<&str>,
  action: &str,
  project_id: Option<&str>,
  environment_id: Option<&str>,
  resource_type: Option<&str>,
  resource_id: Option<&str>,
  metadata: Value,
) -> Result<(), sqlx::Error> {
  let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
  audit(
    &mut transaction,
    actor_type,
    actor_id,
    actor_label,
    action,
    project_id,
    environment_id,
    resource_type,
    resource_id,
    metadata,
  )
  .await?;
  transaction.commit().await
}
