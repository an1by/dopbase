//! Proof that the 0.2.0 baseline keeps its promises, run through the real
//! migrator: the writes the schema must refuse, the upserts the grant store
//! relies on, and the cascades that replaced the 0.1.x triggers. Built from
//! `docs/audit-v2/schema/proposed-schema-proof.sql`. Here to prove the 0.2.0
//! rewrite safe; drop it once end-to-end tests cover the same ground.

use app::services::db::{DbClient, MIGRATOR};

const T: &str = "2026-11-07T09:00:00.000Z";

async fn seeded() -> DbClient {
  let db = DbClient::connect("sqlite::memory:").await.unwrap();
  MIGRATOR.run(db.pool()).await.unwrap();
  for statement in [
    "INSERT INTO accounts (id, kind, is_root, role_id, created_at, updated_at) VALUES ('usr_root', 'user', 1, NULL, $1, $1), ('usr_alice', 'user', 0, 'rol_member', $1, $1), ('usr_bob', 'user', 0, 'rol_admin', $1, $1), ('agt_bot', 'agent', 0, 'rol_ai_agent', $1, $1)",
    "INSERT INTO users (id, email, password_hash) VALUES ('usr_root', 'root@dopbase.com', 'h'), ('usr_alice', 'alice@dopbase.com', 'h'), ('usr_bob', 'bob@dopbase.com', NULL)",
    "INSERT INTO agents (id, name, owner_id) VALUES ('agt_bot', 'deploy-bot', 'usr_alice')",
    "INSERT INTO groups (id, name, created_by, created_at, updated_at) VALUES ('grp_backend', 'Backend', 'usr_bob', $1, $1)",
    "INSERT INTO group_members (group_id, account_id, added_by, created_at) VALUES ('grp_backend', 'usr_alice', 'usr_bob', $1)",
    "INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_api', 'api', $1, $1), ('prj_web', 'web', $1, $1)",
    "INSERT INTO environments (id, project_id, name, protected, created_at, updated_at) VALUES ('env_api_dev', 'prj_api', 'dev', 0, $1, $1), ('env_api_prod', 'prj_api', 'prod', 1, $1, $1), ('env_web_dev', 'prj_web', 'dev', 0, $1, $1)",
    "INSERT INTO grants (id, account_id, group_id, scope, project_id, environment_id, level, granted_by, created_at, updated_at) VALUES \
       ('grt_1', 'usr_alice', NULL, 'project', 'prj_api', NULL, 'write', 'usr_bob', $1, $1), \
       ('grt_2', 'usr_alice', NULL, 'environment', 'prj_api', 'env_api_prod', 'read', 'usr_bob', $1, $1), \
       ('grt_3', NULL, 'grp_backend', 'all', NULL, NULL, 'metadata', 'usr_root', $1, $1), \
       ('grt_4', NULL, 'grp_backend', 'environment', 'prj_web', 'env_web_dev', 'read', 'usr_bob', $1, $1), \
       ('grt_5', 'agt_bot', NULL, 'environment', 'prj_api', 'env_api_dev', 'read', 'usr_alice', $1, $1), \
       ('grt_6', 'usr_bob', NULL, 'project', 'prj_web', NULL, 'project_manager', 'usr_root', $1, $1)",
    "INSERT INTO personal_tokens (id, account_id, name, token_hash, scope, project_id, environment_id, level, created_by, created_at, expires_at) VALUES \
       ('ptk_web', 'usr_alice', 'web-ci', x'01', 'project', 'prj_web', NULL, 'read', 'usr_alice', $1, $1), \
       ('ptk_dev', 'usr_alice', 'api-dev', x'02', 'environment', 'prj_api', 'env_api_dev', 'write', 'usr_alice', $1, $1), \
       ('ptk_audit', 'usr_bob', 'audit', x'03', 'audit', NULL, NULL, 'none', 'usr_bob', $1, $1), \
       ('ptk_bot', 'agt_bot', 'bot', x'04', 'all', NULL, NULL, 'metadata', 'usr_alice', $1, $1)",
  ] {
    sqlx::query(statement)
      .bind(T)
      .execute(db.pool())
      .await
      .unwrap_or_else(|error| panic!("{statement}: {error}"));
  }
  db
}

async fn count(
  db: &DbClient,
  sql: &str,
) -> i64 {
  sqlx::query_scalar(sql).fetch_one(db.pool()).await.unwrap()
}

#[tokio::test]
async fn the_baseline_refuses_every_write_it_should() {
  let db = seeded().await;
  // Accounts with no person or agent row yet, so the uniqueness cases below
  // fail on the email or name alone.
  sqlx::query("INSERT INTO accounts (id, kind, role_id, created_at, updated_at) VALUES ('usr_dup', 'user', 'rol_member', 't', 't'), ('agt_dup', 'agent', 'rol_ai_agent', 't', 't')")
    .execute(db.pool())
    .await
    .unwrap();
  let refused = [
    // A second all-projects grant for a group.
    "INSERT INTO grants (id, group_id, scope, level, created_at, updated_at) VALUES ('bad1', 'grp_backend', 'all', 'read', 't', 't')",
    // Both a user and a group.
    "INSERT INTO grants (id, account_id, group_id, scope, project_id, level, created_at, updated_at) VALUES ('bad2', 'usr_bob', 'grp_backend', 'project', 'prj_api', 'read', 't', 't')",
    // Neither.
    "INSERT INTO grants (id, scope, project_id, level, created_at, updated_at) VALUES ('bad3', 'project', 'prj_api', 'read', 't', 't')",
    // An environment named under the wrong project.
    "INSERT INTO grants (id, account_id, scope, project_id, environment_id, level, created_at, updated_at) VALUES ('bad4', 'usr_bob', 'environment', 'prj_web', 'env_api_dev', 'read', 't', 't')",
    // A user that doesn't exist.
    "INSERT INTO grants (id, account_id, scope, project_id, level, created_at, updated_at) VALUES ('bad5', 'usr_ghost', 'project', 'prj_api', 'read', 't', 't')",
    // Project manager on one environment.
    "INSERT INTO grants (id, account_id, scope, project_id, environment_id, level, created_at, updated_at) VALUES ('bad6', 'usr_bob', 'environment', 'prj_api', 'env_api_dev', 'project_manager', 't', 't')",
    // A project grant with no project.
    "INSERT INTO grants (id, account_id, scope, level, created_at, updated_at) VALUES ('bad7', 'usr_bob', 'project', 'read', 't', 't')",
    // Widening a project grant to all projects by clearing its project.
    "UPDATE grants SET project_id = NULL WHERE id = 'grt_6'",
    // A personal token whose environment belongs to another project.
    "INSERT INTO personal_tokens (id, account_id, name, token_hash, scope, project_id, environment_id, level, created_at, expires_at) VALUES ('bad8', 'usr_bob', 'x', x'09', 'environment', 'prj_web', 'env_api_dev', 'read', 't', 't')",
    // A second root.
    "INSERT INTO accounts (id, kind, is_root, created_at, updated_at) VALUES ('usr_root2', 'user', 1, 't', 't')",
    // Root is a person, never an AI agent.
    "INSERT INTO accounts (id, kind, is_root, created_at, updated_at) VALUES ('agt_root', 'agent', 1, 't', 't')",
    // Case-insensitive uniqueness without COLLATE NOCASE.
    "INSERT INTO users (id, email) VALUES ('usr_dup', 'ALICE@dopbase.com')",
    "INSERT INTO agents (id, name, owner_id) VALUES ('agt_dup', 'Deploy-Bot', 'usr_alice')",
    "INSERT INTO groups (id, name, created_at, updated_at) VALUES ('grp_dup', 'backend', 't', 't')",
    // A person row for an AI agent's account, and an agent row for a
    // person's: each kind keeps to its own table.
    "INSERT INTO users (id, email) VALUES ('agt_bot', 'bot@dopbase.com')",
    "INSERT INTO agents (id, name, owner_id) VALUES ('usr_bob', 'bob-bot', 'usr_alice')",
    // A person row with no account at all.
    "INSERT INTO users (id, email) VALUES ('usr_ghost', 'ghost@dopbase.com')",
    // An AI agent owned by another AI agent, or by nobody.
    "UPDATE agents SET owner_id = 'agt_bot' WHERE id = 'agt_bot'",
    "UPDATE agents SET owner_id = NULL WHERE id = 'agt_bot'",
    // Only people sign in: no session, SSO link or passcode for an agent.
    "INSERT INTO sessions (id, user_id, kind, token_hash, created_at, last_used_at, recent_auth_at, idle_expires_at, absolute_expires_at) VALUES ('ses_bot', 'agt_bot', 'cli', x'0b', 't', 't', 't', 't', 't')",
    "INSERT INTO passcodes (id, user_id, purpose, code_hash, created_at, expires_at) VALUES ('psc_bot', 'agt_bot', 'launch', x'0c', 't', 't')",
    // A runner token made by an AI agent.
    "INSERT INTO runner_tokens (id, environment_id, name, token_hash, created_by, created_at) VALUES ('tok_bot', 'env_api_dev', 'bot', x'0d', 'agt_bot', 't')",
    // An owner who still owns an AI agent.
    "DELETE FROM accounts WHERE id = 'usr_alice'",
    // A role in use.
    "DELETE FROM roles WHERE id = 'rol_ai_agent'",
    // A personal token that never expires.
    "INSERT INTO personal_tokens (id, account_id, name, token_hash, scope, level, created_at) VALUES ('bad9', 'usr_bob', 'y', x'0a', 'all', 'read', 't')",
  ];
  for statement in refused {
    assert!(
      sqlx::query(statement).execute(db.pool()).await.is_err(),
      "the schema let this through: {statement}"
    );
  }

  // Pointing a secret at a version that doesn't exist fails at commit,
  // because the key is deferred.
  let mut tx = db.pool().begin().await.unwrap();
  sqlx::query("INSERT INTO secrets (environment_id, key, current_version, created_at, updated_at) VALUES ('env_api_dev', 'API_KEY', 9, $1, $1)")
    .bind(T)
    .execute(&mut *tx)
    .await
    .unwrap();
  assert!(tx.commit().await.is_err());
}

#[tokio::test]
async fn upserts_keep_the_grant_and_move_only_its_update_time() {
  let db = seeded().await;
  let (id, level, created_at, updated_at): (String, String, String, String) = sqlx::query_as(
    "INSERT INTO grants (id, account_id, scope, project_id, level, granted_by, created_at, updated_at) \
     VALUES ('grt_new', 'usr_alice', 'project', 'prj_api', 'manage', 'usr_bob', $1, $1) \
     ON CONFLICT (account_id, project_id) WHERE scope = 'project' \
     DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by, updated_at = excluded.updated_at \
     RETURNING id, level, created_at, updated_at",
  )
  .bind("2026-11-07T10:00:00.000Z")
  .fetch_one(db.pool())
  .await
  .unwrap();
  assert_eq!(
    (
      id.as_str(),
      level.as_str(),
      created_at.as_str(),
      updated_at.as_str()
    ),
    ("grt_1", "manage", T, "2026-11-07T10:00:00.000Z")
  );
  let (id, level): (String, String) = sqlx::query_as(
    "INSERT INTO grants (id, account_id, scope, project_id, environment_id, level, granted_by, created_at, updated_at) \
     VALUES ('grt_new2', 'usr_alice', 'environment', 'prj_api', 'env_api_prod', 'none', 'usr_bob', $1, $1) \
     ON CONFLICT (account_id, environment_id) \
     DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by, updated_at = excluded.updated_at \
     RETURNING id, level",
  )
  .bind("2026-11-07T10:00:00.000Z")
  .fetch_one(db.pool())
  .await
  .unwrap();
  assert_eq!((id.as_str(), level.as_str()), ("grt_2", "none"));
}

#[tokio::test]
async fn deletes_cascade_where_the_old_triggers_did() {
  let db = seeded().await;
  let mut tx = db.pool().begin().await.unwrap();
  sqlx::query("INSERT INTO secrets (environment_id, key, current_version, created_at, updated_at) VALUES ('env_api_dev', 'API_KEY', 1, $1, $1)")
    .bind(T)
    .execute(&mut *tx)
    .await
    .unwrap();
  sqlx::query("INSERT INTO secret_versions (environment_id, key, version, ciphertext, value_nonce, wrapped_key, key_nonce, change_type, actor_type, created_at) VALUES ('env_api_dev', 'API_KEY', 1, x'aa', x'01', x'bb', x'02', 'created', 'admin', $1)")
    .bind(T)
    .execute(&mut *tx)
    .await
    .unwrap();
  tx.commit().await.unwrap();

  sqlx::query("DELETE FROM environments WHERE id = 'env_api_prod'")
    .execute(db.pool())
    .await
    .unwrap();
  assert_eq!(
    count(&db, "SELECT COUNT(*) FROM grants WHERE id = 'grt_2'").await,
    0
  );
  assert_eq!(count(&db, "SELECT COUNT(*) FROM grants").await, 5);

  sqlx::query("DELETE FROM environments WHERE id = 'env_api_dev'")
    .execute(db.pool())
    .await
    .unwrap();
  assert_eq!(
    count(&db, "SELECT COUNT(*) FROM grants WHERE id = 'grt_5'").await,
    0
  );
  assert_eq!(
    count(
      &db,
      "SELECT COUNT(*) FROM personal_tokens WHERE id = 'ptk_dev'"
    )
    .await,
    0
  );
  assert_eq!(count(&db, "SELECT COUNT(*) FROM secrets").await, 0);
  assert_eq!(count(&db, "SELECT COUNT(*) FROM secret_versions").await, 0);

  sqlx::query("DELETE FROM projects WHERE id = 'prj_web'")
    .execute(db.pool())
    .await
    .unwrap();
  assert_eq!(
    count(
      &db,
      "SELECT COUNT(*) FROM grants WHERE id IN ('grt_4', 'grt_6')"
    )
    .await,
    0
  );
  assert_eq!(
    count(
      &db,
      "SELECT COUNT(*) FROM personal_tokens WHERE id = 'ptk_web'"
    )
    .await,
    0
  );

  sqlx::query("DELETE FROM groups WHERE id = 'grp_backend'")
    .execute(db.pool())
    .await
    .unwrap();
  assert_eq!(
    count(&db, "SELECT COUNT(*) FROM grants WHERE id = 'grt_3'").await,
    0
  );
  assert_eq!(count(&db, "SELECT COUNT(*) FROM group_members").await, 0);

  // Once the agent moves to root, alice can go, and what she made stays
  // with nobody named as its maker.
  sqlx::query("UPDATE agents SET owner_id = 'usr_root' WHERE id = 'agt_bot'")
    .execute(db.pool())
    .await
    .unwrap();
  sqlx::query("DELETE FROM accounts WHERE id = 'usr_alice'")
    .execute(db.pool())
    .await
    .unwrap();
  assert_eq!(
    count(
      &db,
      "SELECT COUNT(*) FROM grants WHERE account_id = 'usr_alice'"
    )
    .await,
    0
  );
  // Deleting the account took its person row with it.
  assert_eq!(
    count(&db, "SELECT COUNT(*) FROM users WHERE id = 'usr_alice'").await,
    0
  );
  assert_eq!(
    count(
      &db,
      "SELECT COUNT(*) FROM personal_tokens WHERE id = 'ptk_bot' AND created_by IS NULL"
    )
    .await,
    1
  );

  // Deleting an AI agent's account takes its agent row, grants and tokens.
  sqlx::query("DELETE FROM accounts WHERE id = 'agt_bot'")
    .execute(db.pool())
    .await
    .unwrap();
  assert_eq!(count(&db, "SELECT COUNT(*) FROM agents").await, 0);
  assert_eq!(
    count(
      &db,
      "SELECT COUNT(*) FROM personal_tokens WHERE account_id = 'agt_bot'"
    )
    .await,
    0
  );

  let dangling: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
    .fetch_all(db.pool())
    .await
    .unwrap();
  assert!(dangling.is_empty());
}

/// Every file in `directory` with its bytes.
fn files(directory: &std::path::Path) -> Vec<(String, Vec<u8>)> {
  let mut files: Vec<(String, Vec<u8>)> = std::fs::read_dir(directory)
    .unwrap()
    .map(|entry| entry.unwrap().path())
    .filter(|path| path.is_file())
    .map(|path| {
      (
        path.file_name().unwrap().to_string_lossy().into_owned(),
        std::fs::read(&path).unwrap(),
      )
    })
    .collect();
  files.sort();
  files
}

// A stopped 0.1.x directory is refused before anything opens it for
// writing: not one file is added, removed or changed, -wal and -shm included.
#[tokio::test]
async fn a_stopped_0_1_x_data_directory_is_refused_without_new_files() {
  // Build the 0.1.x database elsewhere: a pooled connection can finish
  // closing after `close()` returns and touch the side files next to it.
  let staging = tempfile::TempDir::new().unwrap();
  let staged = staging.path().join("dopbase.db");
  let db = DbClient::connect(&format!("sqlite://{}", staged.display()))
    .await
    .unwrap();
  app::services::legacy_schema::LEGACY_MIGRATOR
    .run(db.pool())
    .await
    .unwrap();
  db.checkpoint().await.unwrap();
  db.close().await;
  // A cleanly stopped directory: the checkpoint folded the WAL into the
  // main file, so only the main file comes across.
  let directory = tempfile::TempDir::new().unwrap();
  std::fs::copy(&staged, directory.path().join("dopbase.db")).unwrap();
  let url = format!("sqlite://{}", directory.path().join("dopbase.db").display());
  let before = files(directory.path());
  assert!(
    before.iter().all(|(name, _)| !name.ends_with("-wal")),
    "{:?}",
    before.iter().map(|(name, _)| name).collect::<Vec<_>>()
  );

  let error = app::services::db::refuse_legacy(&url)
    .await
    .unwrap_err()
    .to_string();
  assert!(error.contains("from Dopbase 0.1.x"), "{error}");
  assert_eq!(files(directory.path()), before);

  // A 0.2.0 directory is not refused. (The check also steps aside on a file
  // it can't read, so this half only shows it doesn't refuse 0.2.0.)
  let current = tempfile::TempDir::new().unwrap();
  let url = format!("sqlite://{}", current.path().join("dopbase.db").display());
  let db = DbClient::connect(&url).await.unwrap();
  db.migrate().await.unwrap();
  db.checkpoint().await.unwrap();
  db.close().await;
  app::services::db::refuse_legacy(&url).await.unwrap();
}

#[tokio::test]
async fn a_0_1_x_data_directory_is_refused_untouched() {
  let directory = tempfile::TempDir::new().unwrap();
  let url = format!("sqlite://{}", directory.path().join("dopbase.db").display());
  let db = DbClient::connect(&url).await.unwrap();
  app::services::legacy_schema::LEGACY_MIGRATOR
    .run(db.pool())
    .await
    .unwrap();
  let error = db.migrate().await.unwrap_err().to_string();
  assert!(error.contains("from Dopbase 0.1.x"), "{error}");
  assert!(error.contains("dopbase restore"), "{error}");
  // Nothing of 0.2.0 was written into it.
  assert_eq!(
    count(
      &db,
      "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('users', 'user_identities')"
    )
    .await,
    0
  );
  db.close().await;
}
