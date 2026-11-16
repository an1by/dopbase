//! Upgrades a 0.1.x backup to the 0.2.0 schema, so `dopbase restore` takes
//! old and new backups alike. It runs on temporary copies only: the 0.1.x
//! database is brought to its last 0.1.x shape with the legacy migrations,
//! checked, and copied table by table into a fresh 0.2.0 database. The
//! restore then re-keys and applies that database the usual way.
//!
//! Sessions, sign-in flows, device requests and passcodes are not carried
//! over, so everyone signs in again. Rows that name something that no
//! longer exists can't be expressed with real foreign keys; they are
//! dropped and counted in the report.

use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, SqliteConnection};
use utoipa::ToSchema;

use crate::{
  constants::limits::RUNNER_TOKEN_MAX_DAYS,
  http::HttpError,
  services::{
    audit_chain,
    db::{DbClient, MIGRATOR},
    legacy_schema,
  },
  utils::time::Stamp,
};

/// What upgrading a 0.1.x backup did. Returned with the restore so the
/// operator can see what came across.
#[derive(Clone, Debug, Default, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeReport {
  /// Always `0.1.x`.
  pub upgraded_from: String,
  /// Rows written to each 0.2.0 table.
  pub tables: std::collections::BTreeMap<String, i64>,
  /// Rows left out, and why.
  pub dropped: Vec<UpgradeNote>,
  /// Values that changed on the way, and how.
  pub changed: Vec<UpgradeNote>,
  /// Audit records from before 0.1.x had a hash chain. They are saved to
  /// the audit archive, not restored.
  pub archived_audit_records: u64,
  /// The archive file's name, when there was anything to archive. The
  /// backup carries the file, and restoring it puts the file in the audit
  /// archive directory.
  pub audit_archive: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeNote {
  pub table: String,
  pub rows: i64,
  pub reason: String,
}

impl UpgradeReport {
  pub(crate) fn note(
    list: &mut Vec<UpgradeNote>,
    table: &str,
    rows: i64,
    reason: &str,
  ) {
    if rows > 0 {
      list.push(UpgradeNote {
        table: table.to_owned(),
        rows,
        reason: reason.to_owned(),
      });
    }
  }
}

fn failed(step: &str) -> impl FnOnce(anyhow::Error) -> HttpError + '_ {
  move |error| {
    tracing::warn!(
      error = format!("{error:#}"),
      step,
      "0.1.x backup upgrade failed"
    );
    HttpError::bad_request(
      "BACKUP_UPGRADE_FAILED",
      &format!("This 0.1.x backup could not be upgraded: {step} failed. Nothing was changed."),
    )
  }
}

/// A timestamp from 0.1.x in the 0.2.0 shape. SQLite reads every shape
/// 0.1.x wrote (RFC 3339 with an offset and up to nine fraction digits);
/// anything it can't read is kept as it was.
fn ts(column: &str) -> String {
  format!("COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', {column}), {column})")
}

async fn count(
  connection: &mut SqliteConnection,
  sql: &str,
) -> anyhow::Result<i64> {
  Ok(sqlx::query_scalar(sql).fetch_one(connection).await?)
}

/// Upgrades the 0.1.x database at `legacy` into a new 0.2.0 database at
/// `target`. Pre-chain audit records are archived into `archive_dir`, a
/// temporary directory next to `target`; only a restore copies them into
/// the instance's audit archive.
pub async fn run(
  legacy: &Path,
  target: &Path,
  archive_dir: &Path,
) -> Result<UpgradeReport, HttpError> {
  // 1. The last 0.1.x shape, whatever 0.1.x release made the backup.
  let source = DbClient::connect(&format!("sqlite://{}", legacy.to_string_lossy()))
    .await
    .map_err(failed("opening the backup"))?;
  legacy_schema::migrate_legacy(source.pool())
    .await
    .map_err(failed("bringing it to the last 0.1.x schema"))?;

  // 2. Check it before reading anything out of it.
  let integrity: String = sqlx::query_scalar("PRAGMA quick_check")
    .fetch_one(source.pool())
    .await
    .map_err(|error| failed("the integrity check")(error.into()))?;
  if integrity != "ok" {
    return Err(failed("the integrity check")(anyhow::anyhow!(integrity)));
  }
  let dangling: Vec<(String,)> = sqlx::query_as("SELECT \"table\" FROM pragma_foreign_key_check")
    .fetch_all(source.pool())
    .await
    .map_err(|error| failed("the foreign key check")(error.into()))?;
  if !dangling.is_empty() {
    return Err(failed("the foreign key check")(anyhow::anyhow!(
      "{dangling:?}"
    )));
  }
  source
    .checkpoint()
    .await
    .map_err(|error| failed("reading the backup")(error.into()))?;
  source.close().await;

  // 3. A fresh 0.2.0 database next to it.
  let destination = DbClient::connect(&format!("sqlite://{}", target.to_string_lossy()))
    .await
    .map_err(failed("creating the 0.2.0 database"))?;
  MIGRATOR
    .run(destination.pool())
    .await
    .map_err(|error| failed("creating the 0.2.0 database")(error.into()))?;
  let mut connection = destination
    .pool()
    .acquire()
    .await
    .map_err(|error| failed("creating the 0.2.0 database")(error.into()))?;
  let escaped = legacy.to_string_lossy().replace('\'', "''");
  sqlx::query(&format!("ATTACH DATABASE '{escaped}' AS old"))
    .execute(&mut *connection)
    .await
    .map_err(|error| failed("reading the backup")(error.into()))?;

  let copied = copy(&mut connection, archive_dir).await;
  let _ = sqlx::query("DETACH DATABASE old")
    .execute(&mut *connection)
    .await;
  drop(connection);
  let report = copied.map_err(failed("copying the data"))?;

  // 6. The chain must still verify after the move.
  let chain = audit_chain::verify_against(destination.pool(), None)
    .await
    .map_err(|error| failed("verifying the audit chain")(error.into()))?;
  if !chain.ok {
    return Err(failed("verifying the audit chain")(anyhow::anyhow!(
      "{:?}",
      chain.broken
    )));
  }
  destination
    .checkpoint()
    .await
    .map_err(|error| failed("saving the 0.2.0 database")(error.into()))?;
  destination.close().await;
  Ok(report)
}

/// Step 4 and 5: the table-by-table copy, in one transaction, parents
/// first, with foreign keys on.
async fn copy(
  connection: &mut SqliteConnection,
  archive_dir: &Path,
) -> anyhow::Result<UpgradeReport> {
  let mut report = UpgradeReport {
    upgraded_from: "0.1.x".into(),
    ..UpgradeReport::default()
  };
  let mut tx = connection.begin().await?;
  let now = chrono::Utc::now().stamp();

  let missing_role = count(
    &mut tx,
    "SELECT COUNT(*) FROM old.admins WHERE is_root = 0 AND role_id IS NULL",
  )
  .await?;
  if missing_role > 0 {
    anyhow::bail!("{missing_role} account(s) have no role");
  }

  let statements: Vec<(&str, String)> = vec![
    (
      "instance_metadata",
      "INSERT INTO instance_metadata (id, verification_ciphertext, verification_nonce, created_at) SELECT id, verification_ciphertext, verification_nonce, created_at FROM old.instance_metadata".into(),
    ),
    // Built-in roles come from the baseline.
    (
      "roles",
      format!(
        "INSERT INTO roles (id, name, description, builtin, max_level, sign_in, requires_owner, token_scope, token_max_level, token_default_ttl_days, token_max_ttl_days, rank, created_at, updated_at) \
         SELECT id, name, description, 0, max_level, sign_in, requires_owner, token_scope, token_max_level, token_default_ttl_days, token_max_ttl_days, rank, {}, {} FROM old.roles WHERE builtin = 0",
        ts("created_at"),
        ts("updated_at")
      ),
    ),
    (
      "role_capabilities",
      "INSERT INTO role_capabilities (role_id, capability) SELECT role_id, capability FROM old.role_capabilities WHERE role_id IN (SELECT id FROM roles WHERE builtin = 0)".into(),
    ),
    // Every admins row becomes an account. One whose role signs in with
    // tokens only is an AI agent; everyone else, root included, is a
    // person. `role` is gone, and a creator that's gone becomes nobody.
    (
      "accounts",
      format!(
        "INSERT INTO accounts (id, kind, is_root, role_id, status, disabled_by, created_by, created_at, updated_at) \
         SELECT a.id, CASE WHEN a.is_root = 0 AND r.sign_in = 'token_only' THEN 'agent' ELSE 'user' END, \
                a.is_root, CASE WHEN a.is_root = 1 THEN NULL ELSE a.role_id END, \
                CASE WHEN a.is_root = 1 THEN 'active' ELSE a.status END, \
                CASE WHEN a.is_root = 0 AND a.status = 'disabled' THEN (SELECT e.actor_id FROM old.audit_events e WHERE e.action = 'user.disabled' AND e.resource_id = a.id AND e.actor_id IN (SELECT id FROM old.admins) ORDER BY e.seq DESC, e.created_at DESC LIMIT 1) END, \
                CASE WHEN a.created_by IN (SELECT id FROM old.admins) THEN a.created_by END, \
                {}, {} FROM old.admins a LEFT JOIN roles r ON r.id = a.role_id",
        ts("a.created_at"),
        ts("a.updated_at")
      ),
    ),
    // People keep their email, password (an empty one becomes NULL) and
    // last sign-in.
    (
      "users",
      format!(
        "INSERT INTO users (id, email, password_hash, last_sign_in_at) \
         SELECT a.id, a.email, NULLIF(a.password_hash, ''), {} FROM old.admins a JOIN accounts x ON x.id = a.id AND x.kind = 'user'",
        ts("a.last_sign_in_at")
      ),
    ),
    // AI agents: the old email column held the name. An owner that's gone,
    // or that isn't a person, is replaced by root.
    (
      "agents",
      "INSERT INTO agents (id, name, owner_id) \
       SELECT a.id, a.email, CASE WHEN a.owner_id IN (SELECT id FROM users) THEN a.owner_id ELSE (SELECT id FROM accounts WHERE is_root = 1) END \
         FROM old.admins a JOIN accounts x ON x.id = a.id AND x.kind = 'agent'".into(),
    ),
    (
      "sso_providers",
      format!(
        "INSERT INTO sso_providers (id, preset, display_name, issuer, client_id, client_secret_ciphertext, client_secret_nonce, enabled, require_sso, hide_password_form, verified_at, created_at, updated_at) \
         SELECT id, preset, display_name, issuer, client_id, client_secret_ciphertext, client_secret_nonce, \
                CASE WHEN verified_at IS NULL THEN 0 ELSE enabled END, \
                CASE WHEN verified_at IS NULL OR enabled = 0 THEN 0 ELSE require_sso END, \
                hide_password_form, {}, {}, {} FROM old.sso_providers",
        ts("verified_at"),
        ts("created_at"),
        ts("updated_at")
      ),
    ),
    (
      "user_identities",
      format!(
        "INSERT INTO user_identities (id, user_id, provider_id, issuer, subject, email_at_link, linked_via, created_at, last_login_at) \
         SELECT id, admin_id, provider_id, issuer, subject, email_at_link, linked_via, {}, {} FROM old.admin_identities",
        ts("created_at"),
        ts("last_login_at")
      ),
    ),
    (
      "projects",
      format!(
        "INSERT INTO projects (id, name, created_at, updated_at) SELECT id, name, {}, {} FROM old.projects",
        ts("created_at"),
        ts("updated_at")
      ),
    ),
    (
      "environments",
      format!(
        "INSERT INTO environments (id, project_id, name, protected, env_layout, created_at, updated_at) \
         SELECT e.id, e.project_id, e.name, e.protected, l.layout, {}, {} FROM old.environments e LEFT JOIN old.environment_env_layout l ON l.environment_id = e.id",
        ts("e.created_at"),
        ts("e.updated_at")
      ),
    ),
    (
      "secrets",
      format!(
        "INSERT INTO secrets (environment_id, key, current_version, created_at, updated_at) SELECT environment_id, key, version, {}, {} FROM old.secrets",
        ts("created_at"),
        ts("updated_at")
      ),
    ),
    // History rows, except a current version whose ciphertext differs from
    // the copy `secrets` held: the app served the `secrets` copy, so that
    // one wins below.
    (
      "secret_versions",
      format!(
        "INSERT INTO secret_versions (environment_id, key, version, ciphertext, value_nonce, wrapped_key, key_nonce, encryption_version, change_type, source_version, actor_type, actor_id, actor_label, created_at, expired_at) \
         SELECT v.environment_id, v.key, v.version, v.ciphertext, v.value_nonce, v.wrapped_key, v.key_nonce, v.encryption_version, v.change_type, v.source_version, v.actor_type, v.actor_id, v.actor_label, {}, {} \
           FROM old.secret_versions v JOIN old.secrets s ON s.environment_id = v.environment_id AND s.key = v.key \
          WHERE NOT (v.version = s.version AND v.ciphertext IS NOT s.ciphertext)",
        ts("v.created_at"),
        ts("v.expired_at")
      ),
    ),
    (
      "groups",
      format!(
        "INSERT INTO groups (id, name, description, created_by, created_at, updated_at) \
         SELECT id, name, description, CASE WHEN created_by IN (SELECT id FROM accounts) THEN created_by END, {}, {} FROM old.groups",
        ts("created_at"),
        ts("updated_at")
      ),
    ),
    (
      "group_members",
      format!(
        "INSERT INTO group_members (group_id, account_id, added_by, created_at) \
         SELECT group_id, user_id, CASE WHEN added_by IN (SELECT id FROM accounts) THEN added_by END, {} FROM old.group_members",
        ts("created_at")
      ),
    ),
    (
      "audit_chain_anchor",
      "INSERT INTO audit_chain_anchor (id, pruned_seq, pruned_hash, pruned_at) SELECT id, pruned_seq, pruned_hash, pruned_at FROM old.audit_chain_anchor".into(),
    ),
    // Sealed records verbatim: the hash covers created_at and metadata as
    // stored, so neither may be touched.
    (
      "audit_events",
      "INSERT INTO audit_events (id, seq, actor_type, actor_id, actor_label, action, project_id, environment_id, resource_type, resource_id, ip_address, metadata, created_at, prev_hash, record_hash) \
       SELECT id, seq, actor_type, actor_id, actor_label, action, project_id, environment_id, resource_type, resource_id, ip_address, metadata, created_at, prev_hash, record_hash FROM old.audit_events WHERE seq IS NOT NULL".into(),
    ),
  ];
  for (table, sql) in &statements {
    sqlx::query(sql)
      .execute(&mut *tx)
      .await
      .with_context(|| format!("copying {table}"))?;
  }

  super::workspace_upgrade::upgrade_workspaces(&mut tx, &mut report, &now).await?;

  // Runner tokens didn't record who made them before 0.2.0. They always
  // expire now, a year at most, so one with no expiry or a later one gets
  // the longest lifetime from today. The report counts live tokens only.
  let longest = format!("strftime('%Y-%m-%dT%H:%M:%fZ', $1, '+{RUNNER_TOKEN_MAX_DAYS} days')");
  let runner_no_expiry = count(
    &mut tx,
    "SELECT COUNT(*) FROM old.runner_tokens WHERE expires_at IS NULL AND revoked_at IS NULL",
  )
  .await?;
  let runner_too_long: i64 = sqlx::query_scalar(&format!(
    "SELECT COUNT(*) FROM old.runner_tokens WHERE {} > {longest} AND revoked_at IS NULL",
    ts("expires_at")
  ))
  .bind(&now)
  .fetch_one(&mut *tx)
  .await
  .context("counting runner tokens")?;
  sqlx::query(&format!(
    "INSERT INTO runner_tokens (id, environment_id, name, token_hash, created_by, created_at, expires_at, last_used_at, revoked_at) \
     SELECT id, environment_id, name, token_hash, NULL, {}, \
            CASE WHEN expires_at IS NULL OR {} > {longest} THEN {longest} ELSE {} END, \
            {}, {} FROM old.runner_tokens",
    ts("created_at"),
    ts("expires_at"),
    ts("expires_at"),
    ts("last_used_at"),
    ts("revoked_at")
  ))
  .bind(&now)
  .execute(&mut *tx)
  .await
  .context("copying runner tokens")?;
  UpgradeReport::note(
    &mut report.changed,
    "runner_tokens",
    runner_no_expiry,
    "had no expiry; now expires in 365 days",
  );
  UpgradeReport::note(
    &mut report.changed,
    "runner_tokens",
    runner_too_long,
    "expired more than 365 days out; now expires in 365 days",
  );

  // Current values whose version row is missing or differs. A missing one
  // becomes a `legacy` version, as 0.1.x's own history migration did.
  let missing = count(
    &mut tx,
    "SELECT COUNT(*) FROM old.secrets s WHERE NOT EXISTS (SELECT 1 FROM old.secret_versions v WHERE v.environment_id = s.environment_id AND v.key = s.key AND v.version = s.version)",
  )
  .await?;
  let differing = count(
    &mut tx,
    "SELECT COUNT(*) FROM old.secrets s JOIN old.secret_versions v ON v.environment_id = s.environment_id AND v.key = s.key AND v.version = s.version WHERE v.ciphertext IS NOT s.ciphertext",
  )
  .await?;
  sqlx::query(&format!(
    "INSERT INTO secret_versions (environment_id, key, version, ciphertext, value_nonce, wrapped_key, key_nonce, encryption_version, change_type, source_version, actor_type, actor_id, actor_label, created_at, expired_at) \
     SELECT s.environment_id, s.key, s.version, s.ciphertext, s.value_nonce, s.wrapped_key, s.key_nonce, s.encryption_version, \
            COALESCE(v.change_type, 'legacy'), v.source_version, COALESCE(v.actor_type, 'system'), v.actor_id, v.actor_label, \
            {}, NULL \
       FROM old.secrets s LEFT JOIN old.secret_versions v ON v.environment_id = s.environment_id AND v.key = s.key AND v.version = s.version \
      WHERE v.version IS NULL OR v.ciphertext IS NOT s.ciphertext",
    ts("COALESCE(v.created_at, s.updated_at)")
  ))
  .execute(&mut *tx)
  .await
  .context("copying current secret values")?;
  UpgradeReport::note(
    &mut report.changed,
    "secret_versions",
    missing,
    "current value had no history row; added as a legacy version",
  );
  UpgradeReport::note(
    &mut report.changed,
    "secret_versions",
    differing,
    "history row differed from the current value; the current value was kept",
  );

  // Personal tokens: the scope becomes keys. Tokens on a deleted project or
  // environment were revoked by 0.1.x and can't be expressed now, and a
  // data token with level none reaches nothing. Each dropped token is
  // counted once, under the first reason that applies.
  let gone = "((t.scope_type = 'project' AND t.scope_id NOT IN (SELECT id FROM projects)) OR (t.scope_type = 'environment' AND e.id IS NULL))";
  let nothing = "(t.scope_type <> 'audit' AND t.level = 'none')";
  let tokens = "FROM old.personal_tokens t \
     JOIN accounts u ON u.id = t.user_id \
     LEFT JOIN roles r ON r.id = u.role_id \
     LEFT JOIN environments e ON e.id = t.scope_id";
  let gone_scope = count(&mut tx, &format!("SELECT COUNT(*) {tokens} WHERE {gone}")).await?;
  let reach_nothing = count(
    &mut tx,
    &format!("SELECT COUNT(*) {tokens} WHERE NOT {gone} AND {nothing}"),
  )
  .await?;
  // 0.2.0 checks a token on every use against its role's longest lifetime,
  // counted from when it was made (services/credentials.rs). The expiry
  // carried over says the same, so the token list never shows a token as
  // live that the server refuses: no expiry, or a later one, becomes the
  // end of that lifetime. A creation time SQLite can't read can't be
  // checked, so that token ends now.
  let old_expiry = ts("t.expires_at");
  let role_end = "COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', t.created_at, '+' || COALESCE(r.token_max_ttl_days, 365) || ' days'), $1)";
  let expiry = format!(
    "CASE WHEN {old_expiry} IS NOT NULL AND {old_expiry} <= {role_end} THEN {old_expiry} ELSE {role_end} END"
  );
  // Tokens that worked in 0.1.x: not revoked and not yet expired.
  let live = format!("t.revoked_at IS NULL AND ({old_expiry} IS NULL OR {old_expiry} > $1)");
  let kept = format!("NOT {gone} AND NOT {nothing}");
  let shortened: i64 = sqlx::query_scalar(&format!(
    "SELECT COUNT(*) {tokens} WHERE {kept} AND {live} AND {role_end} > $1 AND ({old_expiry} IS NULL OR {old_expiry} > {role_end})"
  ))
  .bind(&now)
  .fetch_one(&mut *tx)
  .await
  .context("counting personal tokens")?;
  let outlived: i64 = sqlx::query_scalar(&format!(
    "SELECT COUNT(*) {tokens} WHERE {kept} AND {live} AND {role_end} <= $1"
  ))
  .bind(&now)
  .fetch_one(&mut *tx)
  .await
  .context("counting personal tokens")?;
  sqlx::query(&format!(
    "INSERT INTO personal_tokens (id, account_id, name, token_hash, scope, project_id, environment_id, level, created_by, created_at, expires_at, last_used_at, revoked_at) \
     SELECT t.id, t.user_id, t.name, t.token_hash, t.scope_type, \
            CASE t.scope_type WHEN 'project' THEN t.scope_id WHEN 'environment' THEN e.project_id END, \
            CASE t.scope_type WHEN 'environment' THEN t.scope_id END, \
            CASE WHEN t.scope_type = 'audit' THEN 'none' ELSE t.level END, \
            CASE WHEN t.created_by IN (SELECT id FROM accounts) THEN t.created_by END, \
            {}, {expiry}, {}, {} \
       {tokens} WHERE {kept}",
    ts("t.created_at"),
    ts("t.last_used_at"),
    ts("t.revoked_at")
  ))
  .bind(&now)
  .execute(&mut *tx)
  .await
  .context("copying personal tokens")?;
  UpgradeReport::note(
    &mut report.dropped,
    "personal_tokens",
    gone_scope,
    "the project or environment it was limited to was deleted",
  );
  UpgradeReport::note(
    &mut report.dropped,
    "personal_tokens",
    reach_nothing,
    "a data token with level none reached nothing",
  );
  UpgradeReport::note(
    &mut report.changed,
    "personal_tokens",
    shortened,
    "had no expiry, or one past its role's longest token lifetime; now expires when that lifetime ends, counted from when it was made",
  );
  UpgradeReport::note(
    &mut report.changed,
    "personal_tokens",
    outlived,
    "was older than its role's longest token lifetime; brought over as expired",
  );

  // Grants: principal and scope become keys. A grant naming something that
  // was deleted is dropped.
  let keep = "((g.principal_type = 'user' AND g.principal_id IN (SELECT id FROM accounts)) OR (g.principal_type = 'group' AND g.principal_id IN (SELECT id FROM groups))) \
    AND (g.scope_type = 'all' OR (g.scope_type = 'project' AND g.scope_id IN (SELECT id FROM projects)) OR (g.scope_type = 'environment' AND e.id IS NOT NULL))";
  let gone_grants = count(
    &mut tx,
    &format!("SELECT COUNT(*) FROM old.grants g LEFT JOIN environments e ON e.id = g.scope_id WHERE NOT ({keep})"),
  )
  .await?;
  sqlx::query(&format!(
    "INSERT INTO grants (id, account_id, group_id, scope, project_id, environment_id, level, granted_by, created_at, updated_at) \
     SELECT g.id, CASE WHEN g.principal_type = 'user' THEN g.principal_id END, CASE WHEN g.principal_type = 'group' THEN g.principal_id END, \
            g.scope_type, CASE g.scope_type WHEN 'project' THEN g.scope_id WHEN 'environment' THEN e.project_id END, \
            CASE WHEN g.scope_type = 'environment' THEN g.scope_id END, g.level, \
            CASE WHEN g.granted_by IN (SELECT id FROM accounts) THEN g.granted_by END, {}, {} \
       FROM old.grants g LEFT JOIN environments e ON e.id = g.scope_id WHERE {keep}",
    ts("g.created_at"),
    ts("g.created_at")
  ))
  .execute(&mut *tx)
  .await
  .context("copying grants")?;
  UpgradeReport::note(
    &mut report.dropped,
    "grants",
    gone_grants,
    "named an account, group, project or environment that no longer exists",
  );

  let not_carried = count(&mut tx, "SELECT COUNT(*) FROM old.sessions").await?;
  UpgradeReport::note(
    &mut report.dropped,
    "sessions",
    not_carried,
    "sign-ins don't carry over; everyone signs in again",
  );

  // 5. Records from before the chain can't be sealed after the fact. Save
  // them to the audit archive, as retention does, instead of restoring them.
  let pre_chain: Vec<sqlx::sqlite::SqliteRow> = sqlx::query(
    "SELECT id, actor_type, actor_id, actor_label, action, project_id, environment_id, resource_type, resource_id, ip_address, metadata, created_at FROM old.audit_events WHERE seq IS NULL ORDER BY created_at, id",
  )
  .fetch_all(&mut *tx)
  .await?;
  if let (Some(first), Some(last)) = (pre_chain.first(), pre_chain.last()) {
    let mut lines = Vec::new();
    for row in &pre_chain {
      let record = serde_json::json!({
        "id": row.get::<String, _>("id"),
        "actorType": row.get::<String, _>("actor_type"),
        "actorId": row.get::<Option<String>, _>("actor_id"),
        "actorLabel": row.get::<Option<String>, _>("actor_label"),
        "action": row.get::<String, _>("action"),
        "projectId": row.get::<Option<String>, _>("project_id"),
        "environmentId": row.get::<Option<String>, _>("environment_id"),
        "resourceType": row.get::<Option<String>, _>("resource_type"),
        "resourceId": row.get::<Option<String>, _>("resource_id"),
        "ipAddress": row.get::<Option<String>, _>("ip_address"),
        "metadata": row.get::<String, _>("metadata"),
        "createdAt": row.get::<String, _>("created_at"),
      });
      serde_json::to_writer(&mut lines, &record)?;
      lines.push(b'\n');
    }
    let name = format!(
      "audit-0.1.x-{}-{}.jsonl",
      first.get::<String, _>("id"),
      last.get::<String, _>("id")
    );
    let directory = archive_dir.to_owned();
    let path = directory.join(&name);
    tokio::task::spawn_blocking(move || {
      std::fs::create_dir_all(&directory)?;
      crate::utils::private_file::write(&path, &lines, true)
    })
    .await??;
    report.archived_audit_records = pre_chain.len() as u64;
    report.audit_archive = Some(name);
  }

  for table in crate::services::instance_tables::INSTANCE_TABLES {
    let rows = count(&mut tx, &format!("SELECT COUNT(*) FROM {table}")).await?;
    report.tables.insert(table.to_owned(), rows);
  }
  tx.commit().await?;
  Ok(report)
}
