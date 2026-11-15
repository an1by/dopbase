use std::fs;

use app::services::db::{DbClient, MIGRATOR};
use app::services::legacy_schema::LEGACY_MIGRATOR;

#[tokio::test]
async fn connects_pings_and_closes() {
  let db = DbClient::connect("sqlite::memory:").await.unwrap();
  db.ping().await.unwrap();
  db.close().await;
}

#[tokio::test]
async fn connect_sets_pragmas() {
  let directory = tempfile::TempDir::new().unwrap();
  let database = directory.path().join("pragmas.db");
  let db = DbClient::connect(&format!("sqlite://{}", database.display()))
    .await
    .unwrap();
  let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
    .fetch_one(db.pool())
    .await
    .unwrap();
  let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
    .fetch_one(db.pool())
    .await
    .unwrap();
  let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
    .fetch_one(db.pool())
    .await
    .unwrap();
  let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
    .fetch_one(db.pool())
    .await
    .unwrap();
  assert_eq!(journal_mode, "wal");
  assert_eq!(foreign_keys, 1);
  assert_eq!(busy_timeout, 5_000);
  assert_eq!(synchronous, 1);
  db.checkpoint().await.unwrap();
  db.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn creates_owner_only_database_file() {
  use std::os::unix::fs::PermissionsExt;
  let directory = tempfile::TempDir::new().unwrap();
  let database = directory.path().join("private").join("dopbase.db");
  let db = DbClient::connect(&format!("sqlite://{}", database.display()))
    .await
    .unwrap();
  assert_eq!(
    fs::metadata(database).unwrap().permissions().mode() & 0o777,
    0o600
  );
  db.close().await;
}

#[tokio::test]
async fn migrations_apply_rollback_and_reapply() {
  const TABLES: [&str; 23] = [
    "instance_metadata",
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
    "environments",
    "secrets",
    "secret_versions",
    "runner_tokens",
    "personal_tokens",
    "groups",
    "group_members",
    "grants",
    "audit_events",
    "audit_chain_anchor",
  ];
  const TRIGGERS: [&str; 1] = ["audit_events_sealed_immutable"];
  const INDEXES: [&str; 9] = [
    "users_email_uq",
    "accounts_root_uq",
    "agents_name_uq",
    "sessions_idle_idx",
    "audit_events_created_idx",
    "audit_events_action_idx",
    "grants_account_all_uq",
    "grants_group_environment_uq",
    "personal_tokens_environment_idx",
  ];

  let directory = tempfile::TempDir::new().unwrap();
  let database = directory.path().join("migration-cycle.db");
  let db = DbClient::connect(&format!("sqlite://{}", database.display()))
    .await
    .unwrap();

  MIGRATOR.run(db.pool()).await.unwrap();
  MIGRATOR.run(db.pool()).await.unwrap();
  assert_schema_objects(&db, "table", &TABLES, true).await;
  assert_schema_objects(&db, "index", &INDEXES, true).await;
  assert_schema_objects(&db, "trigger", &TRIGGERS, true).await;
  // The old shapes are gone: no type-and-id pairs, no second copy of the
  // current secret value, no pre-chain audit table.
  for table in ["admins", "environment_env_layout", "audit_chain_genesis"] {
    assert_schema_objects(&db, "table", &[table], false).await;
  }
  for (table, column) in [
    ("grants", "principal_type"),
    ("personal_tokens", "scope_type"),
    ("secrets", "ciphertext"),
    ("users", "role"),
  ] {
    let found: i64 =
      sqlx::query_scalar("SELECT COUNT(*) FROM pragma_table_info($1) WHERE name = $2")
        .bind(table)
        .bind(column)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(found, 0, "{table}.{column} should be gone");
  }

  MIGRATOR.undo(db.pool(), 0).await.unwrap();
  assert_schema_objects(&db, "table", &TABLES, false).await;
  assert_schema_objects(&db, "index", &INDEXES, false).await;
  assert_schema_objects(&db, "trigger", &TRIGGERS, false).await;

  MIGRATOR.run(db.pool()).await.unwrap();
  assert_schema_objects(&db, "table", &TABLES, true).await;
  assert_schema_objects(&db, "index", &INDEXES, true).await;
  assert_schema_objects(&db, "trigger", &TRIGGERS, true).await;
  db.close().await;
}

#[tokio::test]
async fn foreign_keys_cascade_dependent_records() {
  let directory = tempfile::TempDir::new().unwrap();
  let database = directory.path().join("cascade.db");
  let db = DbClient::connect(&format!("sqlite://{}", database.display()))
    .await
    .unwrap();
  MIGRATOR.run(db.pool()).await.unwrap();

  sqlx::query("INSERT INTO accounts(id,kind,is_root,role_id,created_at,updated_at) VALUES('usr_test','user',0,'rol_member','now','now')").execute(db.pool()).await.unwrap();
  sqlx::query(
    "INSERT INTO users(id,email,password_hash) VALUES('usr_test','admin@dopbase.com','hash')",
  )
  .execute(db.pool())
  .await
  .unwrap();
  sqlx::query("INSERT INTO sessions(id,user_id,kind,token_hash,created_at,last_used_at,recent_auth_at,idle_expires_at,absolute_expires_at) VALUES('ses_test','usr_test','cli',X'01','now','now','now','later','later')").execute(db.pool()).await.unwrap();
  sqlx::query(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES('prj_test','project','now','now')",
  )
  .execute(db.pool())
  .await
  .unwrap();
  sqlx::query("INSERT INTO environments(id,project_id,name,created_at,updated_at) VALUES('env_test','prj_test','production','now','now')").execute(db.pool()).await.unwrap();
  let mut tx = db.pool().begin().await.unwrap();
  sqlx::query("INSERT INTO secrets(environment_id,key,current_version,created_at,updated_at) VALUES('env_test','API_KEY',1,'now','now')").execute(&mut *tx).await.unwrap();
  sqlx::query("INSERT INTO secret_versions(environment_id,key,version,ciphertext,value_nonce,wrapped_key,key_nonce,change_type,actor_type,created_at) VALUES('env_test','API_KEY',1,X'01',X'02',X'03',X'04','created','admin','now')").execute(&mut *tx).await.unwrap();
  tx.commit().await.unwrap();
  sqlx::query("INSERT INTO runner_tokens(id,environment_id,name,token_hash,created_at) VALUES('tok_test','env_test','runner',X'05','now')").execute(db.pool()).await.unwrap();
  let expiry: Option<String> =
    sqlx::query_scalar("SELECT expires_at FROM runner_tokens WHERE id='tok_test'")
      .fetch_one(db.pool())
      .await
      .unwrap();
  assert!(expiry.is_none());

  sqlx::query("DELETE FROM accounts WHERE id = 'usr_test'")
    .execute(db.pool())
    .await
    .unwrap();
  sqlx::query("DELETE FROM projects WHERE id = 'prj_test'")
    .execute(db.pool())
    .await
    .unwrap();

  for table in [
    "sessions",
    "environments",
    "secrets",
    "secret_versions",
    "runner_tokens",
  ] {
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
      .fetch_one(db.pool())
      .await
      .unwrap();
    assert_eq!(count, 0, "cascade did not clear {table}");
  }
  db.close().await;
}

#[tokio::test]
async fn secret_versions_migration_keeps_existing_values_as_legacy_versions() {
  // A 0.1.x migration the restore upgrade still runs on old backups.
  let directory = tempfile::TempDir::new().unwrap();
  let database = directory.path().join("secret-versions.db");
  let db = DbClient::connect(&format!("sqlite://{}", database.display()))
    .await
    .unwrap();
  LEGACY_MIGRATOR.run(db.pool()).await.unwrap();
  LEGACY_MIGRATOR
    .undo(db.pool(), version_before("secret_versions"))
    .await
    .unwrap();
  sqlx::query(
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES('prj_test','project','now','now')",
  )
  .execute(db.pool())
  .await
  .unwrap();
  sqlx::query("INSERT INTO environments(id,project_id,name,created_at,updated_at) VALUES('env_test','prj_test','production','now','now')").execute(db.pool()).await.unwrap();
  sqlx::query("INSERT INTO secrets(environment_id,key,version,ciphertext,value_nonce,wrapped_key,key_nonce,created_at,updated_at) VALUES('env_test','API_KEY',3,X'01',X'02',X'03',X'04','created','updated')").execute(db.pool()).await.unwrap();

  LEGACY_MIGRATOR.run(db.pool()).await.unwrap();

  let row: (i64, Vec<u8>, Vec<u8>, String, String, String, Option<String>) = sqlx::query_as(
    "SELECT version,ciphertext,wrapped_key,change_type,actor_type,created_at,expired_at FROM secret_versions WHERE environment_id='env_test' AND key='API_KEY'",
  )
  .fetch_one(db.pool())
  .await
  .unwrap();
  assert_eq!(
    row,
    (
      3,
      vec![1],
      vec![3],
      "legacy".into(),
      "system".into(),
      "updated".into(),
      None
    )
  );
  // Half-expired rows are rejected, so a version is either restorable or not.
  let invalid = sqlx::query("UPDATE secret_versions SET ciphertext=NULL WHERE key='API_KEY'")
    .execute(db.pool())
    .await;
  assert!(invalid.is_err());
  db.close().await;
}

async fn assert_schema_objects(
  db: &DbClient,
  object_type: &str,
  names: &[&str],
  expected: bool,
) {
  for name in names {
    let exists: bool =
      sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?)")
        .bind(object_type)
        .bind(name)
        .fetch_one(db.pool())
        .await
        .unwrap();
    assert_eq!(
      exists, expected,
      "unexpected state for {object_type} {name}"
    );
  }
}

/// Return the version immediately before `name` in the 0.1.x migration
/// order.
///
/// Tests undo to this version to revert `name` without pinning its number, so
/// migrations added later do not require touching them.
pub(crate) fn version_before(name: &str) -> i64 {
  // sqlx turns the underscores in a migration's file name into spaces when it
  // derives the description.
  let description = name.replace('_', " ");
  let mut migrations: Vec<_> = LEGACY_MIGRATOR
    .iter()
    .filter(|migration| !migration.migration_type.is_down_migration())
    .collect();
  migrations.sort_by_key(|migration| migration.version);

  let mut previous = 0;
  for migration in migrations {
    if migration.description.as_ref() == description.as_str() {
      return previous;
    }
    previous = migration.version;
  }
  panic!("migration {name} not found");
}
