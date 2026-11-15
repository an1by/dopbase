use super::model::SecretMetadata;
use crate::services::crypto::EncryptedValue;
use sqlx::{QueryBuilder, Sqlite, SqlitePool};

/// A secret's current value lives in its newest version row; `secrets`
/// only points at it.
const CURRENT: &str = "SELECT s.key, s.current_version AS version, v.ciphertext, v.value_nonce, v.wrapped_key, v.key_nonce, s.created_at, s.updated_at \
  FROM secrets s JOIN secret_versions v ON v.environment_id = s.environment_id AND v.key = s.key AND v.version = s.current_version";
#[derive(sqlx::FromRow)]
pub struct SecretRow {
  pub key: String,
  pub version: i64,
  pub ciphertext: Vec<u8>,
  pub value_nonce: Vec<u8>,
  pub wrapped_key: Vec<u8>,
  pub key_nonce: Vec<u8>,
  pub created_at: String,
  pub updated_at: String,
}
impl SecretRow {
  pub fn encrypted(&self) -> EncryptedValue {
    EncryptedValue {
      ciphertext: self.ciphertext.clone(),
      value_nonce: self.value_nonce.clone(),
      wrapped_key: self.wrapped_key.clone(),
      key_nonce: self.key_nonce.clone(),
    }
  }
  pub fn metadata(&self) -> SecretMetadata {
    SecretMetadata {
      key: self.key.clone(),
      version: self.version,
      created_at: self.created_at.clone(),
      updated_at: self.updated_at.clone(),
    }
  }
}
pub async fn list(
  pool: &SqlitePool,
  environment_id: &str,
) -> Result<Vec<SecretMetadata>, sqlx::Error> {
  sqlx::query_as(
    "SELECT key, current_version AS version, created_at, updated_at FROM secrets WHERE environment_id = $1 ORDER BY key",
  )
  .bind(environment_id)
  .fetch_all(pool)
  .await
}
pub async fn rows<'e>(
  executor: impl sqlx::SqliteExecutor<'e>,
  environment_id: &str,
) -> Result<Vec<SecretRow>, sqlx::Error> {
  sqlx::query_as(&format!(
    "{CURRENT} WHERE s.environment_id = $1 ORDER BY s.key"
  ))
  .bind(environment_id)
  .fetch_all(executor)
  .await
}
/// What an environment's revision is made of: each key's version and
/// update time, without any ciphertext.
pub async fn revision_rows<'e>(
  executor: impl sqlx::SqliteExecutor<'e>,
  environment_id: &str,
) -> Result<Vec<(String, i64, String)>, sqlx::Error> {
  sqlx::query_as(
    "SELECT key, current_version, updated_at FROM secrets WHERE environment_id = $1 ORDER BY key",
  )
  .bind(environment_id)
  .fetch_all(executor)
  .await
}
/// The version of each of `keys` the environment has. Keys it doesn't have
/// are left out.
pub async fn versions_of<'e>(
  executor: impl sqlx::SqliteExecutor<'e>,
  environment_id: &str,
  keys: &[&String],
) -> Result<Vec<(String, i64)>, sqlx::Error> {
  if keys.is_empty() {
    return Ok(Vec::new());
  }
  let mut query: QueryBuilder<Sqlite> =
    QueryBuilder::new("SELECT key, current_version FROM secrets WHERE environment_id = ");
  query.push_bind(environment_id);
  push_keys(&mut query, "key", keys);
  query.build_query_as().fetch_all(executor).await
}
/// Like [`rows`], for `keys` only.
pub async fn rows_of<'e>(
  executor: impl sqlx::SqliteExecutor<'e>,
  environment_id: &str,
  keys: &[&String],
) -> Result<Vec<SecretRow>, sqlx::Error> {
  if keys.is_empty() {
    return Ok(Vec::new());
  }
  let mut query: QueryBuilder<Sqlite> = QueryBuilder::new(CURRENT);
  query.push(" WHERE s.environment_id = ");
  query.push_bind(environment_id);
  push_keys(&mut query, "s.key", keys);
  query.push(" ORDER BY s.key");
  query.build_query_as().fetch_all(executor).await
}

/// Appends ` AND column IN ($n, …)` with one placeholder per key, which
/// both SQLite and Postgres read.
fn push_keys<'a>(
  query: &mut QueryBuilder<'a, Sqlite>,
  column: &str,
  keys: &'a [&'a String],
) {
  query.push(format!(" AND {column} IN ("));
  let mut list = query.separated(", ");
  for key in keys {
    list.push_bind(key.as_str());
  }
  list.push_unseparated(")");
}
pub async fn find<'e>(
  executor: impl sqlx::SqliteExecutor<'e>,
  environment_id: &str,
  key: &str,
) -> Result<Option<SecretRow>, sqlx::Error> {
  sqlx::query_as(&format!(
    "{CURRENT} WHERE s.environment_id = $1 AND s.key = $2"
  ))
  .bind(environment_id)
  .bind(key)
  .fetch_optional(executor)
  .await
}
/// The environment's `.env` layout: comments and key order.
pub async fn layout<'e>(
  executor: impl sqlx::SqliteExecutor<'e>,
  environment_id: &str,
) -> Result<Option<String>, sqlx::Error> {
  let row: Option<Option<String>> =
    sqlx::query_scalar("SELECT env_layout FROM environments WHERE id = $1")
      .bind(environment_id)
      .fetch_optional(executor)
      .await?;
  Ok(row.flatten())
}
pub async fn upsert_layout(
  tx: &mut sqlx::SqliteConnection,
  environment_id: &str,
  layout: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE environments SET env_layout = $1 WHERE id = $2")
    .bind(layout)
    .bind(environment_id)
    .execute(tx)
    .await?;
  Ok(())
}

/// What produced a stored version. Stored as text in
/// `secret_versions.change_type`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeType {
  Created,
  Updated,
  Imported,
  RolledBack,
}
impl ChangeType {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Created => "created",
      Self::Updated => "updated",
      Self::Imported => "imported",
      Self::RolledBack => "rolled_back",
    }
  }
}
pub struct VersionActor<'a> {
  pub actor_type: &'a str,
  pub actor_id: Option<&'a str>,
  pub actor_label: Option<&'a str>,
}
pub struct NewVersion<'a> {
  pub environment_id: &'a str,
  pub key: &'a str,
  pub version: i64,
  pub encrypted: EncryptedValue,
  /// When the secret itself was first created. Kept across versions.
  pub created_at: &'a str,
  pub now: &'a str,
  pub change: ChangeType,
  pub source_version: Option<i64>,
  pub actor: VersionActor<'a>,
  /// How many of the newest versions keep their ciphertext.
  pub keep: u32,
}
/// Makes `version` the current value of the secret and records it in the
/// history, then expires ciphertext beyond the retention count. This is the
/// only write path for secret values.
///
/// `secrets` points at its current version through a deferred key, so the
/// two writes run inside a transaction (a savepoint when the caller already
/// holds one) and the key is checked at commit. The upsert must stay
/// `ON CONFLICT DO UPDATE`: deleting the row first would cascade away the
/// whole history.
pub async fn write_version(
  conn: &mut sqlx::SqliteConnection,
  new: NewVersion<'_>,
) -> Result<(), sqlx::Error> {
  let mut tx = sqlx::Connection::begin(&mut *conn).await?;
  let EncryptedValue {
    ciphertext,
    value_nonce,
    wrapped_key,
    key_nonce,
  } = new.encrypted;
  sqlx::query("INSERT INTO secrets(environment_id, key, current_version, created_at, updated_at) VALUES($1, $2, $3, $4, $5) ON CONFLICT(environment_id, key) DO UPDATE SET current_version = excluded.current_version, updated_at = excluded.updated_at")
    .bind(new.environment_id)
    .bind(new.key)
    .bind(new.version)
    .bind(new.created_at)
    .bind(new.now)
    .execute(&mut *tx)
    .await?;
  sqlx::query("INSERT INTO secret_versions(environment_id,key,version,ciphertext,value_nonce,wrapped_key,key_nonce,change_type,source_version,actor_type,actor_id,actor_label,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
    .bind(new.environment_id)
    .bind(new.key)
    .bind(new.version)
    .bind(ciphertext)
    .bind(value_nonce)
    .bind(wrapped_key)
    .bind(key_nonce)
    .bind(new.change.as_str())
    .bind(new.source_version)
    .bind(new.actor.actor_type)
    .bind(new.actor.actor_id)
    .bind(new.actor.actor_label)
    .bind(new.now)
    .execute(&mut *tx)
    .await?;
  sqlx::query("UPDATE secret_versions SET ciphertext=NULL,value_nonce=NULL,wrapped_key=NULL,key_nonce=NULL,expired_at=$1 WHERE environment_id=$2 AND key=$3 AND expired_at IS NULL AND version NOT IN (SELECT version FROM secret_versions WHERE environment_id=$4 AND key=$5 ORDER BY version DESC LIMIT $6)")
    .bind(new.now)
    .bind(new.environment_id)
    .bind(new.key)
    .bind(new.environment_id)
    .bind(new.key)
    .bind(i64::from(new.keep.max(1)))
    .execute(&mut *tx)
    .await?;
  tx.commit().await?;
  Ok(())
}
#[derive(sqlx::FromRow)]
pub struct VersionRow {
  pub version: i64,
  pub change_type: String,
  pub source_version: Option<i64>,
  pub actor_type: String,
  pub actor_label: Option<String>,
  pub created_at: String,
  pub expired_at: Option<String>,
}
/// Version metadata, newest first, strictly older than `before` when set.
pub async fn list_versions(
  pool: &SqlitePool,
  environment_id: &str,
  key: &str,
  before: Option<i64>,
  limit: u32,
) -> Result<Vec<VersionRow>, sqlx::Error> {
  sqlx::query_as("SELECT version,change_type,source_version,actor_type,actor_label,created_at,expired_at FROM secret_versions WHERE environment_id=$1 AND key=$2 AND ($3 IS NULL OR version<$4) ORDER BY version DESC LIMIT $5")
    .bind(environment_id)
    .bind(key)
    .bind(before)
    .bind(before)
    .bind(i64::from(limit))
    .fetch_all(pool)
    .await
}
#[derive(sqlx::FromRow)]
pub struct StoredVersion {
  pub version: i64,
  pub ciphertext: Option<Vec<u8>>,
  pub value_nonce: Option<Vec<u8>>,
  pub wrapped_key: Option<Vec<u8>>,
  pub key_nonce: Option<Vec<u8>>,
}
impl StoredVersion {
  /// The encrypted value, or `None` once retention expired it.
  pub fn encrypted(&self) -> Option<EncryptedValue> {
    Some(EncryptedValue {
      ciphertext: self.ciphertext.clone()?,
      value_nonce: self.value_nonce.clone()?,
      wrapped_key: self.wrapped_key.clone()?,
      key_nonce: self.key_nonce.clone()?,
    })
  }
}
pub async fn find_version(
  conn: &mut sqlx::SqliteConnection,
  environment_id: &str,
  key: &str,
  version: i64,
) -> Result<Option<StoredVersion>, sqlx::Error> {
  sqlx::query_as("SELECT version,ciphertext,value_nonce,wrapped_key,key_nonce FROM secret_versions WHERE environment_id=$1 AND key=$2 AND version=$3")
    .bind(environment_id)
    .bind(key)
    .bind(version)
    .fetch_optional(conn)
    .await
}
