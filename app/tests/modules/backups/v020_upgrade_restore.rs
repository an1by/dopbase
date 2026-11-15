//! `dopbase restore` takes a 0.1.x backup and upgrades it on the way in.
//! These build real 0.1.x backups (the legacy migrations plus seed data,
//! encrypted with another server's key) and restore them during setup and
//! onto a running instance. Here to prove the 0.2.0 upgrade safe; drop
//! them once end-to-end tests cover the same ground.

use super::*;
use app::services::{
  audit_chain::{self, AuditEntry},
  crypto::{CryptoService, sso_client_secret_aad},
  db::DbClient,
  legacy_schema::LEGACY_MIGRATOR,
};
use std::io::Write;

const PASSWORD: &str = "correct-horse-123";
const RUNNER: &str = "dbs_runner_from_0_1";
const PERSONAL: &str = "dpp_member_from_0_1";
const AGENT: &str = "dpa_agent_from_0_1";
/// An AI agent token made longer ago than the agent role's 90 days.
const STALE_AGENT: &str = "dpa_stale_from_0_1";

/// A 0.1.x timestamp `days` before now, in the shape 0.1.x wrote. Token
/// lifetimes count from the real clock, so token fixtures can't use a fixed
/// date.
fn days_ago(days: i64) -> String {
  (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339()
}

/// When a token made at `created_at` reaches `days` of age, as 0.2.0 stores
/// it.
fn days_after(
  created_at: &str,
  days: i64,
) -> String {
  (chrono::DateTime::parse_from_rfc3339(created_at).unwrap() + chrono::Duration::days(days))
    .with_timezone(&chrono::Utc)
    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
    .to_string()
}

fn password_hash() -> String {
  use argon2::PasswordHasher;
  let salt = argon2::password_hash::SaltString::encode_b64(b"fixture-salt-16b").unwrap();
  argon2::Argon2::default()
    .hash_password(PASSWORD.as_bytes(), &salt)
    .unwrap()
    .to_string()
}

fn old_key() -> Vec<u8> {
  (1..=32).collect()
}

/// Zips a database file the way 0.1.x did and encrypts it with `key`.
fn seal_legacy(
  db_path: &std::path::Path,
  key: &[u8],
) -> Vec<u8> {
  let mut buffer = std::io::Cursor::new(Vec::new());
  {
    let mut zip = zip::ZipWriter::new(&mut buffer);
    let options = zip::write::SimpleFileOptions::default();
    zip.start_file("manifest.json", options).unwrap();
    zip
      .write_all(
        json!({"version":"0.1.10","created_at":"2026-10-01T00:00:00+00:00","backup_name":"old.dop","magic":"DOPBASE_BACKUP_V2"})
          .to_string()
          .as_bytes(),
      )
      .unwrap();
    zip.start_file("dopbase.db", options).unwrap();
    zip.write_all(&std::fs::read(db_path).unwrap()).unwrap();
    zip.finish().unwrap();
  }
  CryptoService::from_key(key.to_vec())
    .encrypt_backup(&buffer.into_inner())
    .unwrap()
}

/// A 0.1.x backup with one of everything, made with [`old_key`]. With
/// `broken`, an account has no role, which the upgrade must refuse.
async fn legacy_backup(broken: bool) -> Vec<u8> {
  let directory = TempDir::new().unwrap();
  let path = directory.path().join("dopbase.db");
  let db = DbClient::connect(&format!("sqlite://{}", path.display()))
    .await
    .unwrap();
  LEGACY_MIGRATOR.run(db.pool()).await.unwrap();
  let old = CryptoService::from_key(old_key());
  let now = "2026-10-01T09:30:00.123456789+00:00";
  let later = "2999-01-01T00:00:00+00:00";
  let hash = password_hash();
  let (verification, verification_nonce) = old
    .encrypt_master(b"dopbase-master-key-v1", b"instance-verification")
    .unwrap();
  sqlx::query("INSERT INTO instance_metadata(id,verification_ciphertext,verification_nonce,created_at) VALUES(1,?,?,?)")
    .bind(verification)
    .bind(verification_nonce)
    .bind(now)
    .execute(db.pool())
    .await
    .unwrap();
  for statement in [
    "INSERT INTO admins(id,email,password_hash,role,created_at,updated_at,is_root,role_id,status) VALUES('usr_old_root','root@dopbase.com',?1,'root',?2,?2,1,NULL,'active')",
    "INSERT INTO admins(id,email,password_hash,role,created_at,updated_at,is_root,role_id,status,last_sign_in_at) VALUES('usr_member','member@dopbase.com',?1,'member',?2,?2,0,'rol_member','active',?2)",
    "INSERT INTO admins(id,email,password_hash,role,created_at,updated_at,is_root,role_id,status,owner_id) VALUES('usr_agent','build-agent','','ai_agent',?2,?2,0,'rol_ai_agent','active','usr_member')",
    "INSERT INTO roles(id,name,max_level,created_at,updated_at) VALUES('rol_contractor','Contractor','read',?2,?2)",
    "INSERT INTO role_capabilities(role_id,capability) VALUES('rol_contractor','tokens.personal')",
    "INSERT INTO admins(id,email,password_hash,role,created_at,updated_at,is_root,role_id,status) VALUES('usr_contractor','contractor@dopbase.com',?1,'member',?2,?2,0,'rol_contractor','active')",
    "INSERT INTO sessions(id,admin_id,kind,token_hash,created_at,last_used_at,recent_auth_at,idle_expires_at,absolute_expires_at) VALUES('ses_old','usr_old_root','cli',x'99',?2,?2,?2,?2,?2)",
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES('prj_api','api',?2,?2)",
    "INSERT INTO environments(id,project_id,name,created_at,updated_at,protected) VALUES('env_prod','prj_api','prod',?2,?2,1)",
    "INSERT INTO environment_env_layout(environment_id,layout,updated_at) VALUES('env_prod','# kept\nAPI_KEY=',?2)",
    "INSERT INTO groups(id,name,created_by,created_at,updated_at) VALUES('grp_backend','Backend','usr_gone',?2,?2)",
    "INSERT INTO group_members(group_id,user_id,added_by,created_at) VALUES('grp_backend','usr_member','usr_old_root',?2)",
    "INSERT INTO grants(id,principal_type,principal_id,scope_type,scope_id,level,granted_by,created_at) VALUES('grt_project','user','usr_member','project','prj_api','write','usr_old_root',?2)",
    "INSERT INTO grants(id,principal_type,principal_id,scope_type,scope_id,level,granted_by,created_at) VALUES('grt_env','group','grp_backend','environment','env_prod','read',NULL,?2)",
    "INSERT INTO grants(id,principal_type,principal_id,scope_type,scope_id,level,granted_by,created_at) VALUES('grt_gone','user','usr_member','environment','env_gone','read',NULL,?2)",
  ] {
    sqlx::query(statement)
      .bind(&hash)
      .bind(now)
      .execute(db.pool())
      .await
      .unwrap();
  }
  let issued = days_ago(10);
  let stale = days_ago(200);
  for (id, user, name, raw, scope, scope_id, level, created, expires) in [
    (
      "ptk_member",
      "usr_member",
      "laptop",
      PERSONAL,
      "project",
      "prj_api",
      "read",
      &issued,
      Some(later),
    ),
    (
      "ptk_agent",
      "usr_agent",
      "ci",
      AGENT,
      "all",
      "",
      "metadata",
      &issued,
      None,
    ),
    (
      "ptk_stale",
      "usr_agent",
      "old-ci",
      STALE_AGENT,
      "all",
      "",
      "metadata",
      &stale,
      None,
    ),
    (
      "ptk_gone",
      "usr_member",
      "old",
      "dpp_gone",
      "project",
      "prj_gone",
      "read",
      &issued,
      Some(later),
    ),
  ] {
    sqlx::query("INSERT INTO personal_tokens(id,user_id,name,token_hash,scope_type,scope_id,level,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(id)
      .bind(user)
      .bind(name)
      .bind(app::services::token::hash(raw))
      .bind(scope)
      .bind(scope_id)
      .bind(level)
      .bind(created)
      .bind(expires)
      .execute(db.pool())
      .await
      .unwrap();
  }
  sqlx::query("INSERT INTO runner_tokens(id,environment_id,name,token_hash,created_at) VALUES('tok_ci','env_prod','ci',?,?)")
    .bind(app::services::token::hash(RUNNER))
    .bind(now)
    .execute(db.pool())
    .await
    .unwrap();
  // A revoked token gets an expiry too, but the report doesn't count it.
  sqlx::query("INSERT INTO runner_tokens(id,environment_id,name,token_hash,created_at,revoked_at) VALUES('tok_old','env_prod','old',?,?,?)")
    .bind(app::services::token::hash("dbs_runner_revoked_from_0_1"))
    .bind(now)
    .bind(now)
    .execute(db.pool())
    .await
    .unwrap();
  // Runner tokens always expire now: one set past the 365-day cap.
  sqlx::query("INSERT INTO runner_tokens(id,environment_id,name,token_hash,created_at,expires_at) VALUES('tok_far','env_prod','far',?,?,?)")
    .bind(app::services::token::hash("dbs_runner_far_from_0_1"))
    .bind(now)
    .bind(later)
    .execute(db.pool())
    .await
    .unwrap();

  // API_KEY has two versions; LEGACY_ONLY was never given a history row.
  let one = old.encrypt(b"one", "env_prod", "API_KEY", 1).unwrap();
  let two = old.encrypt(b"two", "env_prod", "API_KEY", 2).unwrap();
  let only = old.encrypt(b"only", "env_prod", "LEGACY_ONLY", 1).unwrap();
  for (key, version, value) in [("API_KEY", 2_i64, &two), ("LEGACY_ONLY", 1, &only)] {
    sqlx::query("INSERT INTO secrets(environment_id,key,version,ciphertext,value_nonce,wrapped_key,key_nonce,created_at,updated_at) VALUES('env_prod',?,?,?,?,?,?,?,?)")
      .bind(key)
      .bind(version)
      .bind(&value.ciphertext)
      .bind(&value.value_nonce)
      .bind(&value.wrapped_key)
      .bind(&value.key_nonce)
      .bind(now)
      .bind(now)
      .execute(db.pool())
      .await
      .unwrap();
  }
  for (version, value) in [(1_i64, &one), (2, &two)] {
    sqlx::query("INSERT INTO secret_versions(environment_id,key,version,ciphertext,value_nonce,wrapped_key,key_nonce,change_type,actor_type,created_at) VALUES('env_prod','API_KEY',?,?,?,?,?,'updated','admin',?)")
      .bind(version)
      .bind(&value.ciphertext)
      .bind(&value.value_nonce)
      .bind(&value.wrapped_key)
      .bind(&value.key_nonce)
      .bind(now)
      .execute(db.pool())
      .await
      .unwrap();
  }
  sqlx::query("DELETE FROM secret_versions WHERE key = 'LEGACY_ONLY'")
    .execute(db.pool())
    .await
    .unwrap();

  let (sso_secret, sso_nonce) = old
    .encrypt_master(b"sso-client-secret", &sso_client_secret_aad("sso_old"))
    .unwrap();
  sqlx::query("INSERT INTO sso_providers(id,preset,display_name,issuer,client_id,client_secret_ciphertext,client_secret_nonce,enabled,verified_at,created_at,updated_at) VALUES('sso_old','generic','Okta','https://idp.example.com','dopbase',?,?,1,?,?,?)")
    .bind(sso_secret)
    .bind(sso_nonce)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(db.pool())
    .await
    .unwrap();
  sqlx::query("INSERT INTO admin_identities(id,admin_id,provider_id,issuer,subject,linked_via,created_at) VALUES('idn_member','usr_member','sso_old','https://idp.example.com','member-subject','manual',?)")
    .bind(now)
    .execute(db.pool())
    .await
    .unwrap();

  // One record from before the chain, then two sealed ones.
  sqlx::query("INSERT INTO audit_events(id,actor_type,action,metadata,created_at) VALUES('aud_pre','admin','secret.updated','{}','2020-01-01T00:00:00+00:00')")
    .execute(db.pool())
    .await
    .unwrap();
  for index in 0..2 {
    let mut tx = db.pool().begin_with("BEGIN IMMEDIATE").await.unwrap();
    audit_chain::append(
      &mut tx,
      &AuditEntry {
        id: &format!("aud_chain_{index}"),
        actor_type: "admin",
        actor_id: Some("usr_member"),
        actor_label: Some("member@dopbase.com"),
        action: "secret.updated",
        project_id: Some("prj_api"),
        environment_id: Some("env_prod"),
        resource_type: Some("secret"),
        resource_id: Some("API_KEY"),
        ip_address: None,
        metadata: "{}",
        created_at: now,
      },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
  }
  if broken {
    sqlx::query("UPDATE admins SET role_id = NULL WHERE id = 'usr_contractor'")
      .execute(db.pool())
      .await
      .unwrap();
  }
  db.checkpoint().await.unwrap();
  db.close().await;
  seal_legacy(&path, &old_key())
}

/// A multipart body with the setup token (when given) first, then the
/// backup and the key it was made with.
fn multipart(
  setup_token: Option<&str>,
  backup: &[u8],
) -> (String, Vec<u8>) {
  let boundary = "v020-upgrade-boundary";
  let mut body = Vec::new();
  if let Some(token) = setup_token {
    body.extend_from_slice(
      format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"setup_token\"\r\n\r\n{token}\r\n"
      )
      .as_bytes(),
    );
  }
  body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"old.dop\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
  body.extend_from_slice(backup);
  body.extend_from_slice(format!("\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"master_key\"; filename=\"master.key\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
  body.extend_from_slice(&old_key());
  body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
  (boundary.to_owned(), body)
}

async fn send_multipart(
  router: &Router,
  path: &str,
  token: Option<&str>,
  setup_token: Option<&str>,
  backup: &[u8],
) -> (u16, Value) {
  let (boundary, body) = multipart(setup_token, backup);
  let mut request = Request::builder().method("POST").uri(path).header(
    header::CONTENT_TYPE,
    format!("multipart/form-data; boundary={boundary}"),
  );
  if let Some(token) = token {
    request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
  }
  let response = router
    .clone()
    .oneshot(request.body(Body::from(body)).unwrap())
    .await
    .unwrap();
  let status = response.status().as_u16();
  let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
  (
    status,
    serde_json::from_slice(&bytes).unwrap_or(Value::Null),
  )
}

async fn sign_in(
  router: &Router,
  email: &str,
) -> String {
  let (status, login, _) = call(
    router,
    "POST",
    "/api/v1/auth/login",
    None,
    Some(json!({"email":email,"password":PASSWORD,"sessionKind":"cli"})),
  )
  .await;
  assert_eq!(status, 200, "{login}");
  login["data"]["token"].as_str().unwrap().to_owned()
}

fn note(
  list: &Value,
  table: &str,
) -> i64 {
  list
    .as_array()
    .unwrap()
    .iter()
    .filter(|note| note["table"] == table)
    .map(|note| note["rows"].as_i64().unwrap())
    .sum()
}

/// What every restored 0.1.x backup must look like afterwards.
async fn assert_upgraded(
  state: &app::state::AppState,
  router: &Router,
  token: &str,
) {
  // Secrets decrypt under this server's key, history and the value that
  // had no history row included.
  for (path, expected) in [
    (
      "/api/v1/environments/env_prod/secrets/API_KEY/reveal",
      "two",
    ),
    (
      "/api/v1/environments/env_prod/secrets/API_KEY/versions/1/reveal",
      "one",
    ),
    (
      "/api/v1/environments/env_prod/secrets/LEGACY_ONLY/reveal",
      "only",
    ),
  ] {
    let (status, body, _) = call(router, "POST", path, Some(token), None).await;
    assert_eq!(status, 200, "{path}: {body}");
    assert_eq!(body["data"]["value"], expected, "{path}");
  }
  // The old token values still work: personal, 0.1.x agent and runner.
  for raw in [PERSONAL, AGENT] {
    let (status, body, _) = call(router, "GET", "/api/v1/projects", Some(raw), None).await;
    assert_eq!(status, 200, "{raw}: {body}");
  }
  let (status, body, _) = call(router, "GET", "/api/v1/runtime/secrets", Some(RUNNER), None).await;
  assert_eq!(status, 200, "runner: {body}");
  // The dropped token is gone, and one older than its role allows came
  // across expired, so the list never shows it live while the server
  // refuses it.
  for raw in ["dpp_gone", STALE_AGENT] {
    let (status, _, _) = call(router, "GET", "/api/v1/projects", Some(raw), None).await;
    assert_eq!(status, 401, "{raw}");
  }
  // Every expiry ends where the role's longest lifetime does, counted from
  // when the token was made: 90 days for an AI agent, 365 for a member,
  // even when 0.1.x gave a later one.
  let tokens: Vec<(String, String, String)> = sqlx::query_as(
    "SELECT id, created_at, expires_at FROM personal_tokens WHERE id IN ('ptk_agent','ptk_member','ptk_stale') ORDER BY id",
  )
  .fetch_all(state.db.pool())
  .await
  .unwrap();
  assert_eq!(tokens.len(), 3);
  for (id, created_at, expires_at) in tokens {
    let days = if id == "ptk_member" { 365 } else { 90 };
    assert_eq!(expires_at, days_after(&created_at, days), "{id}");
  }
  // Runner tokens with no expiry, or one past the cap, expire in 365 days.
  let runner_expiries: Vec<String> =
    sqlx::query_scalar("SELECT expires_at FROM runner_tokens WHERE id IN ('tok_ci','tok_far')")
      .fetch_all(state.db.pool())
      .await
      .unwrap();
  assert_eq!(runner_expiries.len(), 2);
  // The revoked one gets an expiry too; only the report leaves it out.
  let revoked_expiry: Option<String> =
    sqlx::query_scalar("SELECT expires_at FROM runner_tokens WHERE id = 'tok_old'")
      .fetch_one(state.db.pool())
      .await
      .unwrap();
  assert!(revoked_expiry.is_some());
  for expiry in runner_expiries {
    let days = (chrono::DateTime::parse_from_rfc3339(&expiry)
      .unwrap()
      .with_timezone(&chrono::Utc)
      - chrono::Utc::now())
    .num_days();
    assert!((364..=365).contains(&days), "{expiry}");
  }
  // Grants became keys; the one naming a deleted environment is gone.
  let grants: Vec<(String, Option<String>, Option<String>, String)> = sqlx::query_as(
    "SELECT id, account_id, group_id, scope FROM grants WHERE id IN ('grt_project','grt_env','grt_gone') ORDER BY id",
  )
  .fetch_all(state.db.pool())
  .await
  .unwrap();
  assert_eq!(
    grants,
    [
      (
        "grt_env".into(),
        None,
        Some("grp_backend".into()),
        "environment".into()
      ),
      (
        "grt_project".into(),
        Some("usr_member".into()),
        None,
        "project".into()
      ),
    ]
  );
  // The AI agent moved out of the people table: its name is in `agents`,
  // with its owner, and only people are left in `users`.
  let agent: (String, String, String) = sqlx::query_as(
    "SELECT a.kind, g.name, g.owner_id FROM accounts a JOIN agents g ON g.id = a.id WHERE a.id = 'usr_agent'",
  )
  .fetch_one(state.db.pool())
  .await
  .unwrap();
  assert_eq!(
    agent,
    ("agent".into(), "build-agent".into(), "usr_member".into())
  );
  let agent_as_person: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = 'usr_agent'")
      .fetch_one(state.db.pool())
      .await
      .unwrap();
  assert_eq!(agent_as_person, 0);
  // The layout moved onto the environment, timestamps took one shape.
  let (layout, updated): (Option<String>, String) =
    sqlx::query_as("SELECT env_layout, updated_at FROM environments WHERE id = 'env_prod'")
      .fetch_one(state.db.pool())
      .await
      .unwrap();
  assert_eq!(layout.as_deref(), Some("# kept\nAPI_KEY="));
  assert_eq!(updated, "2026-10-01T09:30:00.123Z");
  // The SSO client secret was re-encrypted, the identity link kept.
  let (secret, nonce): (Vec<u8>, Vec<u8>) = sqlx::query_as(
    "SELECT client_secret_ciphertext, client_secret_nonce FROM sso_providers WHERE id = 'sso_old'",
  )
  .fetch_one(state.db.pool())
  .await
  .unwrap();
  assert_eq!(
    state
      .crypto
      .decrypt_master(&secret, &nonce, &sso_client_secret_aad("sso_old"))
      .unwrap(),
    b"sso-client-secret"
  );
  let linked: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM user_identities WHERE user_id = 'usr_member'")
      .fetch_one(state.db.pool())
      .await
      .unwrap();
  assert_eq!(linked, 1);
  // The chain carried over verbatim and still verifies.
  let (status, verified, _) = call(
    router,
    "GET",
    "/api/v1/audit-events/verify",
    Some(token),
    None,
  )
  .await;
  assert_eq!(status, 200);
  assert_eq!(verified["data"]["ok"], true, "{verified}");
  let carried: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM audit_events WHERE id IN ('aud_chain_0','aud_chain_1')",
  )
  .fetch_one(state.db.pool())
  .await
  .unwrap();
  assert_eq!(carried, 2);
  let dangling: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
    .fetch_all(state.db.pool())
    .await
    .unwrap();
  assert!(dangling.is_empty());
}

fn assert_report(report: &Value) {
  assert_eq!(report["upgradedFrom"], "0.1.x", "{report}");
  assert_eq!(report["tables"]["secrets"], 2);
  assert_eq!(report["tables"]["secret_versions"], 3);
  assert_eq!(note(&report["dropped"], "personal_tokens"), 1);
  assert_eq!(note(&report["dropped"], "grants"), 1);
  assert_eq!(note(&report["dropped"], "sessions"), 1);
  // The member's and the agent's tokens were shortened; the stale one
  // came across expired.
  assert_eq!(note(&report["changed"], "personal_tokens"), 3);
  let expired: i64 = report["changed"]
    .as_array()
    .unwrap()
    .iter()
    .filter(|note| {
      note["table"] == "personal_tokens"
        && note["reason"]
          .as_str()
          .unwrap()
          .contains("brought over as expired")
    })
    .map(|note| note["rows"].as_i64().unwrap())
    .sum();
  assert_eq!(expired, 1);
  assert_eq!(note(&report["changed"], "runner_tokens"), 2);
  assert_eq!(note(&report["changed"], "secret_versions"), 1);
  assert_eq!(report["archivedAuditRecords"], 1);
}

#[tokio::test]
async fn setup_restore_upgrades_a_0_1_x_backup() {
  let (dir, state, router) = test_app().await;
  let setup = state.setup.read().await.token.clone().unwrap();
  let backup = legacy_backup(false).await;
  let (status, body) = send_multipart(
    &router,
    "/api/v1/bootstrap/restore",
    None,
    Some(&setup),
    &backup,
  )
  .await;
  assert_eq!(status, 200, "{body}");
  assert_report(&body["data"]["upgrade"]);
  let archive = body["data"]["upgrade"]["auditArchive"].as_str().unwrap();
  let archived = std::fs::read_to_string(dir.path().join("audit-archive").join(archive)).unwrap();
  assert!(archived.contains("aud_pre"));

  // Every account came across, root included, and signs in again.
  let token = sign_in(&router, "root@dopbase.com").await;
  assert_upgraded(&state, &router, &token).await;
  sign_in(&router, "member@dopbase.com").await;
  let sessions_from_backup: i64 =
    sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE id = 'ses_old'")
      .fetch_one(state.db.pool())
      .await
      .unwrap();
  assert_eq!(sessions_from_backup, 0, "everyone signs in again");
  state.db.close().await;
}

#[tokio::test]
async fn restore_on_a_running_instance_upgrades_a_0_1_x_backup() {
  let (dir, state, router, token) = admin_setup().await;
  let backup = legacy_backup(false).await;
  let (status, uploaded) = send_multipart(
    &router,
    "/api/v1/backups/upload",
    Some(&token),
    None,
    &backup,
  )
  .await;
  assert_eq!(status, 201, "{uploaded}");
  assert_report(&uploaded["data"]["upgrade"]);
  let key = uploaded["data"]["key"].as_str().unwrap();
  // Uploading changes nothing live: the set-aside audit records travel in
  // the stored backup and reach the audit archive only on restore.
  let archive = uploaded["data"]["upgrade"]["auditArchive"]
    .as_str()
    .unwrap()
    .to_owned();
  let archived = dir.path().join("audit-archive").join(&archive);
  assert!(!archived.exists(), "upload wrote {archive}");

  // The upload was upgraded and re-keyed already, so restore needs no key.
  let (status, restored, _) = call(
    &router,
    "POST",
    &format!("/api/v1/backups/{key}/restore"),
    Some(&token),
    None,
  )
  .await;
  assert_eq!(status, 200, "{restored}");
  assert!(
    std::fs::read_to_string(&archived)
      .unwrap()
      .contains("aud_pre")
  );
  // The admin who restored stays; the backup's root gives way.
  let roots: Vec<String> = sqlx::query_scalar(
    "SELECT u.email FROM users u JOIN accounts a ON a.id = u.id WHERE a.is_root = 1",
  )
  .fetch_all(state.db.pool())
  .await
  .unwrap();
  assert_eq!(roots, ["admin@dopbase.com"]);
  // The agent's owner was the backup's member, who came across.
  let owner: Option<String> =
    sqlx::query_scalar("SELECT owner_id FROM agents WHERE id = 'usr_agent'")
      .fetch_one(state.db.pool())
      .await
      .unwrap();
  assert_eq!(owner.as_deref(), Some("usr_member"));
  assert_upgraded(&state, &router, &token).await;
  state.db.close().await;
}

#[tokio::test]
async fn a_backup_that_cannot_be_upgraded_changes_nothing() {
  let (_dir, state, router, token) = admin_setup().await;
  let (status, _, _) = call(
    &router,
    "POST",
    "/api/v1/projects",
    Some(&token),
    Some(json!({"name":"still-here"})),
  )
  .await;
  assert_eq!(status, 201);
  let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events")
    .fetch_one(state.db.pool())
    .await
    .unwrap();
  let backup = legacy_backup(true).await;
  let (status, body) = send_multipart(
    &router,
    "/api/v1/backups/upload",
    Some(&token),
    None,
    &backup,
  )
  .await;
  assert_eq!(status, 400, "{body}");
  assert!(body["error"]["BACKUP_UPGRADE_FAILED"].is_string(), "{body}");
  let (_, projects, _) = call(&router, "GET", "/api/v1/projects", Some(&token), None).await;
  assert_eq!(projects["data"][0]["name"], "still-here");
  let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events")
    .fetch_one(state.db.pool())
    .await
    .unwrap();
  assert_eq!(after, before);
  state.db.close().await;
}

/// 0.1.9 and earlier recorded four-digit migration versions. The upgrade
/// rewrites them, runs the later 0.1.x migrations, then the 0.2.0 upgrade.
#[tokio::test]
async fn a_backup_from_0_1_9_is_upgraded_too() {
  let directory = TempDir::new().unwrap();
  let legacy_dir = directory.path().join("legacy");
  std::fs::create_dir(&legacy_dir).unwrap();
  let mut ups: Vec<String> =
    std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations-legacy"))
      .unwrap()
      .map(|entry| entry.unwrap().file_name().into_string().unwrap())
      .filter(|name| name.ends_with(".up.sql"))
      .collect();
  ups.sort();
  for (index, name) in ups.iter().take(18).enumerate() {
    std::fs::copy(
      std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("migrations-legacy")
        .join(name),
      legacy_dir.join(format!("{:04}_legacy.up.sql", index + 1)),
    )
    .unwrap();
    std::fs::write(
      legacy_dir.join(format!("{:04}_legacy.down.sql", index + 1)),
      "",
    )
    .unwrap();
  }
  let path = directory.path().join("dopbase.db");
  let db = DbClient::connect(&format!("sqlite://{}", path.display()))
    .await
    .unwrap();
  sqlx::migrate::Migrator::new(legacy_dir.as_path())
    .await
    .unwrap()
    .run(db.pool())
    .await
    .unwrap();
  let old = CryptoService::from_key(old_key());
  let (verification, nonce) = old
    .encrypt_master(b"dopbase-master-key-v1", b"instance-verification")
    .unwrap();
  sqlx::query("INSERT INTO instance_metadata(id,verification_ciphertext,verification_nonce,created_at) VALUES(1,?,?,'2026-09-01T00:00:00+00:00')")
    .bind(verification)
    .bind(nonce)
    .execute(db.pool())
    .await
    .unwrap();
  for statement in [
    "INSERT INTO admins(id,email,password_hash,role,created_at,updated_at) VALUES('usr_root','root@dopbase.com',?1,'root','t','t')",
    "INSERT INTO admins(id,email,password_hash,role,created_at,updated_at) VALUES('usr_member','member@dopbase.com',?1,'member','t','t')",
    "INSERT INTO projects(id,name,created_at,updated_at) VALUES('prj_api','api','t','t')",
    "INSERT INTO environments(id,project_id,name,created_at,updated_at) VALUES('env_prod','prj_api','prod','t','t')",
  ] {
    sqlx::query(statement)
      .bind(password_hash())
      .execute(db.pool())
      .await
      .unwrap();
  }
  let value = old
    .encrypt(b"from-0.1.9", "env_prod", "API_KEY", 1)
    .unwrap();
  sqlx::query("INSERT INTO secrets(environment_id,key,version,ciphertext,value_nonce,wrapped_key,key_nonce,created_at,updated_at) VALUES('env_prod','API_KEY',1,?,?,?,?,'t','t')")
    .bind(&value.ciphertext)
    .bind(&value.value_nonce)
    .bind(&value.wrapped_key)
    .bind(&value.key_nonce)
    .execute(db.pool())
    .await
    .unwrap();
  db.checkpoint().await.unwrap();
  db.close().await;
  let backup = seal_legacy(&path, &old_key());

  let (_dir, state, router) = test_app().await;
  let setup = state.setup.read().await.token.clone().unwrap();
  let (status, body) = send_multipart(
    &router,
    "/api/v1/bootstrap/restore",
    None,
    Some(&setup),
    &backup,
  )
  .await;
  assert_eq!(status, 200, "{body}");
  let token = sign_in(&router, "root@dopbase.com").await;
  let (status, revealed, _) = call(
    &router,
    "POST",
    "/api/v1/environments/env_prod/secrets/API_KEY/reveal",
    Some(&token),
    None,
  )
  .await;
  assert_eq!(status, 200, "{revealed}");
  assert_eq!(revealed["data"]["value"], "from-0.1.9");
  // The 0.1.x role migration gave the member their access, and it came
  // across as a real all-projects grant.
  let member_grant: String = sqlx::query_scalar(
    "SELECT level FROM grants WHERE account_id = 'usr_member' AND scope = 'all'",
  )
  .fetch_one(state.db.pool())
  .await
  .unwrap();
  assert_eq!(member_grant, "write");
  state.db.close().await;
}

/// A backup carries the audit records a 0.1.x upgrade set aside under
/// `audit-archive/`. Only file names the upgrade writes are taken, so a
/// crafted entry can't write outside the restore's temporary folder.
#[tokio::test]
async fn a_backup_s_audit_archive_entries_cannot_name_other_paths() {
  let (dir, state, router, token) = admin_setup().await;
  let (status, _, _) = call(
    &router,
    "POST",
    "/api/v1/backups",
    Some(&token),
    Some(json!({"name":"source"})),
  )
  .await;
  assert_eq!(status, 201);
  let (status, sealed, _) =
    call_raw(&router, "GET", "/api/v1/backups/source.dop", Some(&token)).await;
  assert_eq!(status, 200);
  let opened = state.crypto.decrypt_backup(&sealed).unwrap();

  for entry in [
    "audit-archive/../../escape.jsonl",
    "audit-archive/audit-0.1.x-a/../../escape.jsonl",
    "audit-archive/not-an-archive.txt",
  ] {
    let mut source = zip::ZipArchive::new(std::io::Cursor::new(opened.clone())).unwrap();
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
      let mut zip = zip::ZipWriter::new(&mut buffer);
      let options = zip::write::SimpleFileOptions::default();
      for index in 0..source.len() {
        let mut file = source.by_index(index).unwrap();
        let name = file.name().unwrap().into_owned();
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut bytes).unwrap();
        zip.start_file(name, options).unwrap();
        zip.write_all(&bytes).unwrap();
      }
      zip.start_file(entry, options).unwrap();
      zip.write_all(b"{}\n").unwrap();
      zip.finish().unwrap();
    }
    let crafted = state.crypto.encrypt_backup(&buffer.into_inner()).unwrap();
    let (status, body) = send_multipart(
      &router,
      "/api/v1/backups/upload",
      Some(&token),
      None,
      &crafted,
    )
    .await;
    assert_eq!(status, 400, "{entry}: {body}");
    assert!(
      body["error"]["BACKUP_CORRUPT"].is_string(),
      "{entry}: {body}"
    );
  }
  assert!(!dir.path().join("escape.jsonl").exists());
  assert!(!dir.path().join("audit-archive").exists());
  state.db.close().await;
}
