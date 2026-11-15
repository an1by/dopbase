use crate::utils::time::Stamp;
use chrono::Utc;

use super::{model::*, repository};
use crate::modules::backups::snapshot;
use crate::modules::common;
use crate::{
  constants::{errors::RATE_LIMITED, tokens::ADMIN_ID_PREFIX},
  http::HttpError,
  models::{AdminRole, SessionKind},
  services::{cache::Reservation, token},
  state::AppState,
};

const SETUP_LIMIT_KEY: &str = "bootstrap";
/// Wrong setup tokens all clients together may send per window.
const SETUP_SHARED_LIMIT: u32 = 50;
pub async fn status(state: &AppState) -> Result<BootstrapStatus, HttpError> {
  let count = repository::admin_count(state.db.pool()).await?;
  Ok(BootstrapStatus {
    state: if count == 0 { "setupRequired" } else { "ready" },
  })
}
pub struct CreatedAdmin {
  pub response: BootstrapAdminResponse,
  pub session_token: String,
}
pub(crate) struct RootCredentials {
  pub email: String,
  pub password_hash: String,
}

pub(crate) async fn prepare_root(
  email: &str,
  password: String,
) -> Result<RootCredentials, HttpError> {
  let email = common::validate_email(email)?;
  common::validate_password(&password)?;
  let password_hash = common::hash_password_async(password).await?;
  Ok(RootCredentials {
    email,
    password_hash,
  })
}

pub(crate) async fn create_root(
  tx: &mut sqlx::SqliteConnection,
  credentials: &RootCredentials,
  now: &chrono::DateTime<Utc>,
) -> Result<String, HttpError> {
  let admin_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts")
    .fetch_one(&mut *tx)
    .await?;
  if admin_count > 0 {
    return Err(HttpError::conflict(
      "BOOTSTRAP_CLOSED",
      "This instance has already been initialized.",
    ));
  }
  let admin_id = token::public_id(ADMIN_ID_PREFIX);
  repository::insert_admin(
    tx,
    &admin_id,
    &credentials.email,
    &credentials.password_hash,
    &now.stamp(),
  )
  .await?;
  common::audit(
    &mut *tx,
    AdminRole::Root.audit_actor_type(),
    Some(&admin_id),
    Some(&credentials.email),
    crate::services::events::Action::AdminBootstrapped,
    None,
    None,
    Some("admin"),
    Some(&admin_id),
    serde_json::json!({}),
  )
  .await?;
  Ok(admin_id)
}

/// One setup try, held against two budgets: five wrong tokens per client
/// address, and a ceiling every address shares. One caller can no longer
/// close setup for everyone, and a flood from many addresses still can't
/// guess at will.
struct SetupAttempt {
  address: Reservation,
  everyone: Reservation,
}

impl SetupAttempt {
  fn fail(self) {
    self.address.fail();
    self.everyone.fail();
  }

  fn release(self) {
    self.address.release();
    self.everyone.release();
  }

  fn succeed(self) {
    self.address.succeed();
    self.everyone.succeed();
  }
}

async fn reserve_setup_attempt(state: &AppState) -> Result<SetupAttempt, HttpError> {
  let limited = || {
    HttpError::new(
      axum::http::StatusCode::TOO_MANY_REQUESTS,
      RATE_LIMITED,
      "Too many setup attempts. Please try again later.",
    )
  };
  let key = format!(
    "{SETUP_LIMIT_KEY}:{}",
    crate::services::client_ip::bucket(crate::services::client_ip::current())
  );
  let address = state.rate_limiter.reserve(&key).await.ok_or_else(limited)?;
  let everyone = state
    .rate_limiter
    .reserve_up_to(SETUP_LIMIT_KEY, SETUP_SHARED_LIMIT)
    .await
    .ok_or_else(limited)?;
  Ok(SetupAttempt { address, everyone })
}

/// Checks a setup token without claiming the setup window. Restore calls
/// this before it reads the uploaded file, so a caller without the token
/// can't make the server buffer a large body. The full restore checks the
/// token again under the setup lock.
pub async fn verify_setup_token(
  state: &AppState,
  setup_token: &str,
) -> Result<(), HttpError> {
  let attempt = reserve_setup_attempt(state).await?;
  let expected = state.setup.read().await.token.clone().ok_or_else(|| {
    HttpError::conflict(
      "BOOTSTRAP_CLOSED",
      "This instance has already been initialized.",
    )
  })?;
  if !token::constant_time_eq(setup_token, &expected) {
    attempt.fail();
    return Err(HttpError::unauthorized(
      "SETUP_TOKEN_INVALID",
      "The setup token is invalid.",
    ));
  }
  attempt.release();
  Ok(())
}

pub async fn create(
  state: &AppState,
  request: BootstrapAdminRequest,
) -> Result<CreatedAdmin, HttpError> {
  let attempt = reserve_setup_attempt(state).await?;
  let email = common::validate_email(&request.email)?;
  common::validate_password(&request.password)?;
  let mut setup = state.setup.write().await;
  let expected = setup.token.clone().ok_or_else(|| {
    HttpError::conflict(
      "BOOTSTRAP_CLOSED",
      "This instance has already been initialized.",
    )
  })?;
  if !token::constant_time_eq(&request.setup_token, &expected) {
    attempt.fail();
    return Err(HttpError::unauthorized(
      "SETUP_TOKEN_INVALID",
      "The setup token is invalid.",
    ));
  }
  let credentials = prepare_root(&email, request.password).await?;
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let admin_id = create_root(&mut tx, &credentials, &Utc::now()).await?;
  // The same session every other sign-in gets, so root's first sign-in is
  // recorded too.
  let session =
    crate::modules::auth::service::issue_session(&mut tx, &admin_id, SessionKind::Browser).await?;
  tx.commit().await?;
  setup.token = None;
  attempt.succeed();
  Ok(CreatedAdmin {
    response: BootstrapAdminResponse {
      admin_id,
      email,
      role: AdminRole::Root,
      csrf_token: session.csrf.ok_or_else(HttpError::internal)?,
      last_login_at: Some(session.created_at.stamp()),
    },
    session_token: session.token,
  })
}

pub async fn restore_bootstrap(
  state: &AppState,
  filename: &str,
  bytes: Vec<u8>,
  setup_token: &str,
  provided_master_key: Option<&[u8]>,
) -> Result<BootstrapRestoreResponse, HttpError> {
  let attempt = reserve_setup_attempt(state).await?;

  // Claim the setup window for the whole operation. This serializes restore
  // with normal bootstrap and prevents two expensive restores racing.
  let mut setup = state.setup.write().await;
  let expected = setup.token.clone().ok_or_else(|| {
    HttpError::conflict(
      "BOOTSTRAP_CLOSED",
      "This instance has already been initialized.",
    )
  })?;
  if !token::constant_time_eq(setup_token, &expected) {
    attempt.fail();
    return Err(HttpError::unauthorized(
      "SETUP_TOKEN_INVALID",
      "The setup token is invalid.",
    ));
  }

  // Verify server is uninitialized
  let admin_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts")
    .fetch_one(state.db.pool())
    .await
    .map_err(|_| HttpError::internal())?;

  if admin_count > 0 {
    return Err(HttpError::conflict(
      "BOOTSTRAP_CLOSED",
      "This instance has already been initialized.",
    ));
  }

  // 1. Try decrypting with this server's master key, then the given one.
  let opened = match snapshot::open_file(state, bytes, provided_master_key).await? {
    Ok(opened) => opened,
    Err(snapshot::Unopened::WrongKey) => {
      return Err(HttpError::bad_request(
        "BACKUP_DECRYPT_FAILED",
        "Failed to decrypt backup. Ensure you provided the correct master key for this backup.",
      ));
    }
    Err(snapshot::Unopened::KeyRequired) => {
      return Err(HttpError::bad_request(
        "BACKUP_KEY_REQUIRED",
        "This backup was created on a different server or with a different master key. Please provide the master key from that server to restore it.",
      ));
    }
  };
  let needs_rekey = opened.rekey_from.is_some();

  let target_key = crate::modules::backups::service::sanitize_key(filename)
    .unwrap_or_else(|_| format!("restore_{}.dop", chrono::Utc::now().format("%Y%m%d_%H%M%S")));

  // 2. The same checks, upgrade and re-key as any other restore.
  let prepared = snapshot::prepare(state, opened.archive, opened.rekey_from.as_deref()).await?;
  let upgrade = prepared.upgrade.clone();
  // Keep a copy in the backup folder, keyed to this server.
  let final_bytes = if needs_rekey || upgrade.is_some() {
    snapshot::seal(state, &prepared, &target_key).await?
  } else {
    opened.file
  };
  let backup_dir = crate::modules::backups::service::backup_dir(state);
  crate::utils::private_file::write(&backup_dir.join(&target_key), &final_bytes, false).map_err(
    |error| {
      tracing::error!(%error, "failed to save the restored backup");
      HttpError::internal()
    },
  )?;

  snapshot::apply(
    state,
    &prepared,
    None,
    snapshot::RestoreRecord {
      key: &target_key,
      details: serde_json::json!({}),
    },
  )
  .await?;

  // Audit event for bootstrap restore
  common::audit_standalone(
    state.db.pool(),
    "bootstrap",
    None,
    None,
    crate::services::events::Action::BackupRestoredBootstrap,
    None,
    None,
    Some("backup"),
    Some(&target_key),
    serde_json::json!({
      "backup": target_key,
      "size": final_bytes.len(),
      "rekeyed": needs_rekey,
      "upgradedFrom": upgrade.as_ref().map(|report| report.upgraded_from.as_str()),
      "upgrade": upgrade,
    }),
  )
  .await?;

  // Close bootstrap window
  setup.token = None;
  attempt.succeed();

  Ok(BootstrapRestoreResponse {
    message: "Backup restored successfully.".to_string(),
    restored: true,
    key: target_key,
    size: final_bytes.len() as u64,
    upgrade,
  })
}
