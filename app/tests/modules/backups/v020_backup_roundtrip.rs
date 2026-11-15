//! A backup then a restore gives back every table as it was, apart from the
//! rules restore applies on purpose. Here to prove the 0.2.0 snapshot module
//! safe; drop it once end-to-end tests cover the same ground. The two bug
//! checks (security audit v1 M8, architecture audit B10) stay.

use super::*;

/// Every row of `table`, each as its quoted column values, in key order.
async fn rows(
  pool: &sqlx::SqlitePool,
  table: &str,
) -> Vec<String> {
  let columns: Vec<String> = sqlx::query_scalar(&format!(
    "SELECT name FROM pragma_table_info('{table}') ORDER BY cid"
  ))
  .fetch_all(pool)
  .await
  .unwrap();
  let quoted = columns
    .iter()
    .map(|column| format!("quote({column})"))
    .collect::<Vec<_>>()
    .join(" || '|' || ");
  sqlx::query_scalar(&format!("SELECT {quoted} FROM {table} ORDER BY 1"))
    .fetch_all(pool)
    .await
    .unwrap()
}

/// Seeds one of everything a backup carries, through the API where it can.
async fn seed(
  state: &app::state::AppState,
  router: &Router,
  token: &str,
) -> (String, String) {
  let (_, project, _) = call(
    router,
    "POST",
    "/api/v1/projects",
    Some(token),
    Some(json!({"name":"roundtrip"})),
  )
  .await;
  let project_id = project["data"]["id"].as_str().unwrap().to_owned();
  let (_, environment, _) = call(
    router,
    "POST",
    &format!("/api/v1/projects/{project_id}/environments"),
    Some(token),
    Some(json!({"name":"production","protected":true})),
  )
  .await;
  let environment_id = environment["data"]["id"].as_str().unwrap().to_owned();
  for value in ["one", "two"] {
    let (status, _, _) = call(
      router,
      "PUT",
      &format!("/api/v1/environments/{environment_id}/secrets/API_KEY"),
      Some(token),
      Some(json!({"value":value})),
    )
    .await;
    assert_eq!(status, 200);
  }
  let (status, _, _) = call(
    router,
    "POST",
    &format!("/api/v1/environments/{environment_id}/tokens"),
    Some(token),
    Some(json!({"name":"ci","role":"runner"})),
  )
  .await;
  assert_eq!(status, 201);
  let now = Utc::now().to_rfc3339();
  for statement in [
    "INSERT INTO accounts(id,kind,role_id,created_at,updated_at) VALUES('usr_member','user','rol_member',$1,$1),('usr_agent','agent','rol_ai_agent',$1,$1)",
    "INSERT INTO users(id,email,password_hash,last_sign_in_at) VALUES('usr_member','member@dopbase.com','hash',$1)",
    "INSERT INTO agents(id,name,owner_id) VALUES('usr_agent','build-agent','usr_member')",
    "INSERT INTO roles(id,name,max_level,created_at,updated_at) VALUES('rol_custom','Contractor','read',$1,$1)",
    "INSERT INTO role_capabilities(role_id,capability) VALUES('rol_custom','tokens.personal')",
    "INSERT INTO groups(id,name,created_at,updated_at) VALUES('grp_ops','Ops',$1,$1)",
    "INSERT INTO group_members(group_id,account_id,created_at) VALUES('grp_ops','usr_member',$1)",
    "INSERT INTO personal_tokens(id,account_id,name,token_hash,scope,level,created_at,expires_at) VALUES('ptk_member','usr_member','laptop',x'0102','all','read',$1,'2999-01-01T00:00:00.000Z')",
  ] {
    sqlx::query(statement)
      .bind(&now)
      .execute(state.db.pool())
      .await
      .unwrap();
  }
  sqlx::query("INSERT INTO grants(id,group_id,scope,project_id,environment_id,level,created_at,updated_at) VALUES('grt_ops','grp_ops','environment',$1,$2,'read',$3,$3)")
    .bind(&project_id)
    .bind(&environment_id)
    .bind(&now)
    .execute(state.db.pool())
    .await
    .unwrap();
  (project_id, environment_id)
}

#[tokio::test]
async fn backup_then_restore_gives_back_every_table() {
  let (_dir, state, router, token) = admin_setup().await;
  seed(&state, &router, &token).await;
  let (status, _, _) = call(
    &router,
    "POST",
    "/api/v1/backups",
    Some(&token),
    Some(json!({"name":"roundtrip"})),
  )
  .await;
  assert_eq!(status, 201);

  let compared = [
    "roles",
    "role_capabilities",
    "user_identities",
    "projects",
    "environments",
    "secrets",
    "secret_versions",
    "runner_tokens",
    "groups",
    "group_members",
    "grants",
    "audit_chain_anchor",
  ];
  let mut before = Vec::new();
  for table in compared {
    before.push(rows(state.db.pool(), table).await);
  }
  let users_before = rows(state.db.pool(), "users").await;
  let accounts_before = rows(state.db.pool(), "accounts").await;
  let agents_before = rows(state.db.pool(), "agents").await;
  assert_eq!(agents_before.len(), 1, "the snapshot holds an AI agent");
  let audit_before = rows(state.db.pool(), "audit_events").await;

  // Changes after the snapshot that the restore must undo.
  let (status, _, _) = call(
    &router,
    "POST",
    "/api/v1/projects",
    Some(&token),
    Some(json!({"name":"after-the-snapshot"})),
  )
  .await;
  assert_eq!(status, 201);
  sqlx::query("DELETE FROM groups")
    .execute(state.db.pool())
    .await
    .unwrap();

  let (status, body, _) = call(
    &router,
    "POST",
    "/api/v1/backups/roundtrip.dop/restore",
    Some(&token),
    None,
  )
  .await;
  assert_eq!(status, 200, "{body}");
  assert!(
    body["data"].get("upgrade").is_none(),
    "a 0.2.0 backup needs no upgrade"
  );

  for (table, expected) in compared.iter().zip(before) {
    assert_eq!(
      rows(state.db.pool(), table).await,
      expected,
      "{table} differs after the round trip"
    );
  }
  assert_eq!(rows(state.db.pool(), "users").await, users_before);
  assert_eq!(rows(state.db.pool(), "accounts").await, accounts_before);
  assert_eq!(rows(state.db.pool(), "agents").await, agents_before);
  // The snapshot's records come back unchanged. It was taken just before
  // its own `backup.created` record, and the restore adds one record.
  let audit_after = rows(state.db.pool(), "audit_events").await;
  assert_eq!(audit_after.len(), audit_before.len());
  let kept = audit_before.len() - 1;
  assert_eq!(audit_after[..kept], audit_before[..kept]);
  let (status, verified, _) = call(
    &router,
    "GET",
    "/api/v1/audit-events/verify",
    Some(&token),
    None,
  )
  .await;
  assert_eq!(status, 200);
  assert_eq!(verified["data"]["ok"], true, "{verified}");
  let dangling: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
    .fetch_all(state.db.pool())
    .await
    .unwrap();
  assert!(dangling.is_empty());
  state.db.close().await;
}

// Security audit v1 M8: a token revoked after the backup was made came back
// to life when the backup was restored.
#[tokio::test]
async fn a_token_revoked_after_the_backup_stays_revoked() {
  let (_dir, state, router, token) = admin_setup().await;
  seed(&state, &router, &token).await;
  let (status, _, _) = call(
    &router,
    "POST",
    "/api/v1/backups",
    Some(&token),
    Some(json!({"name":"before_revoke"})),
  )
  .await;
  assert_eq!(status, 201);
  let revoked_at = Utc::now().to_rfc3339();
  sqlx::query("UPDATE personal_tokens SET revoked_at = $1 WHERE id = 'ptk_member'")
    .bind(&revoked_at)
    .execute(state.db.pool())
    .await
    .unwrap();
  sqlx::query("UPDATE runner_tokens SET revoked_at = $1")
    .bind(&revoked_at)
    .execute(state.db.pool())
    .await
    .unwrap();

  let (status, body, _) = call(
    &router,
    "POST",
    "/api/v1/backups/before_revoke.dop/restore",
    Some(&token),
    None,
  )
  .await;
  assert_eq!(status, 200, "{body}");
  let live: i64 = sqlx::query_scalar(
    "SELECT (SELECT COUNT(*) FROM personal_tokens WHERE revoked_at IS NULL AND id = 'ptk_member') + (SELECT COUNT(*) FROM runner_tokens WHERE revoked_at IS NULL)",
  )
  .fetch_one(state.db.pool())
  .await
  .unwrap();
  assert_eq!(live, 0, "revoked tokens came back to life");
  state.db.close().await;
}

// Architecture audit B10: the account that ran the restore lost its last
// sign-in time, because it was copied with a column list that predated it.
#[tokio::test]
async fn the_restoring_account_keeps_every_column() {
  let (_dir, state, router, token) = admin_setup().await;
  let (status, _, _) = call(
    &router,
    "POST",
    "/api/v1/backups",
    Some(&token),
    Some(json!({"name":"root_kept"})),
  )
  .await;
  assert_eq!(status, 201);
  sqlx::query("UPDATE users SET last_sign_in_at = '2031-01-01T00:00:00.000Z' WHERE id = (SELECT id FROM accounts WHERE is_root = 1)")
    .execute(state.db.pool())
    .await
    .unwrap();
  let before = rows(state.db.pool(), "users").await;
  let accounts_before = rows(state.db.pool(), "accounts").await;

  let (status, body, _) = call(
    &router,
    "POST",
    "/api/v1/backups/root_kept.dop/restore",
    Some(&token),
    None,
  )
  .await;
  assert_eq!(status, 200, "{body}");
  assert_eq!(rows(state.db.pool(), "users").await, before);
  assert_eq!(rows(state.db.pool(), "accounts").await, accounts_before);
  let kept: Option<String> = sqlx::query_scalar(
    "SELECT u.last_sign_in_at FROM users u JOIN accounts a ON a.id = u.id WHERE a.is_root = 1",
  )
  .fetch_one(state.db.pool())
  .await
  .unwrap();
  assert_eq!(kept.as_deref(), Some("2031-01-01T00:00:00.000Z"));
  // The session that ran the restore still works.
  let (status, _, _) = call(&router, "GET", "/api/v1/projects", Some(&token), None).await;
  assert_eq!(status, 200);
  state.db.close().await;
}
