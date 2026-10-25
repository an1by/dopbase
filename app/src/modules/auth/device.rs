//! Browser-approved CLI login. The CLI asks for a device code, shows the
//! user a short user code, and polls until someone signed in to the Admin UI
//! approves that code. The CLI never sees a password or a browser session,
//! so this works the same whether the browser session came from a password
//! or from single sign-on.

use super::{model::*, service::issue_session};
use crate::{
  constants::{
    api::auth::CLI_APPROVE_PAGE,
    errors::{
      AUTHORIZATION_DENIED, DEVICE_ACCESS_DENIED, DEVICE_CODE_EXPIRED, DEVICE_CODE_INVALID,
      RATE_LIMITED,
    },
    limits::{
      CLI_DEVICE_CODE_MINUTES, CLI_DEVICE_POLL_INTERVAL_SECONDS, MAX_PENDING_CLI_DEVICE_REQUESTS,
      MAX_PENDING_CLI_DEVICE_REQUESTS_PER_CLIENT,
    },
    tokens::{DEVICE_CODE_PREFIX, DEVICE_REQUEST_ID_PREFIX},
  },
  extractors::{require_project_manager, require_recent_browser_auth},
  http::HttpError,
  models::{AdminRole, AuthIdentity, SessionKind},
  modules::common,
  services::{client_ip, token},
  state::AppState,
};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, Utc};

/// Consonants only (RFC 8628 section 6.1): no vowels to spell words, and
/// nothing that reads as another character.
const USER_CODE_ALPHABET: &[u8] = b"BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH: usize = 8;
const MAX_HOSTNAME_LENGTH: usize = 64;
/// A login can be approved by anyone signed in; a confirmation only by the
/// owner of the CLI session it confirms. Binds the approver's account ID.
const OWNED_BY_APPROVER: &str =
  "(purpose='login' OR target_session_id IN (SELECT id FROM sessions WHERE admin_id=?))";

#[derive(sqlx::FromRow)]
struct PendingRow {
  client_hostname: Option<String>,
  client_ip: Option<String>,
  created_at: String,
  expires_at: String,
  purpose: String,
}

#[derive(sqlx::FromRow)]
struct DeviceRow {
  id: String,
  status: String,
  expires_at: String,
  last_polled_at: Option<String>,
}

fn generate_user_code() -> Result<String, HttpError> {
  let mut code = String::with_capacity(USER_CODE_LENGTH);
  // Rejection sampling keeps every letter equally likely: 240 is the
  // largest multiple of the alphabet size that fits in a byte.
  let limit = (256 / USER_CODE_ALPHABET.len() * USER_CODE_ALPHABET.len()) as u8;
  while code.len() < USER_CODE_LENGTH {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| HttpError::internal())?;
    for byte in bytes {
      if byte < limit && code.len() < USER_CODE_LENGTH {
        code.push(USER_CODE_ALPHABET[byte as usize % USER_CODE_ALPHABET.len()] as char);
      }
    }
  }
  Ok(code)
}

/// `WDJB-MJHT`, `wdjb mjht`, and `WDJBMJHT` are the same code.
fn normalize_user_code(value: &str) -> Option<String> {
  let code: String = value
    .chars()
    .filter(|character| !matches!(character, '-' | ' '))
    .map(|character| character.to_ascii_uppercase())
    .collect();
  (code.len() == USER_CODE_LENGTH && code.bytes().all(|byte| USER_CODE_ALPHABET.contains(&byte)))
    .then_some(code)
}

fn display_user_code(code: &str) -> String {
  format!("{}-{}", &code[..4], &code[4..])
}

/// The hostname is shown to the approver, so keep it short and plain.
fn sanitize_hostname(value: Option<&str>) -> Option<String> {
  let hostname: String = value?
    .trim()
    .chars()
    .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '.' | '_'))
    .take(MAX_HOSTNAME_LENGTH)
    .collect();
  (!hostname.is_empty()).then_some(hostname)
}

fn parse_time(value: &str) -> Result<DateTime<Utc>, HttpError> {
  DateTime::parse_from_rfc3339(value)
    .map(|time| time.with_timezone(&Utc))
    .map_err(|_| HttpError::internal())
}

fn invalid_code() -> HttpError {
  HttpError::bad_request(
    DEVICE_CODE_INVALID,
    "This login request is invalid or was already used. Run `dopbase login` again.",
  )
}

fn unknown_user_code() -> HttpError {
  HttpError::not_found(
    DEVICE_CODE_INVALID,
    "This code is invalid or has expired. Check the code in your terminal.",
  )
}

fn rate_limited() -> HttpError {
  HttpError::new(
    StatusCode::TOO_MANY_REQUESTS,
    RATE_LIMITED,
    "Too many attempts. Please try again later.",
  )
}

/// Approving hands out a long-lived CLI session, so only a human signed in
/// to the Admin UI may do it, never another CLI session or a token.
fn require_browser_human(identity: &AuthIdentity) -> Result<(&str, &str, &str), HttpError> {
  let (admin_id, email) = require_project_manager(identity)?;
  match identity {
    AuthIdentity::Admin {
      kind: SessionKind::Browser,
      session_id,
      ..
    } => Ok((admin_id, email, session_id)),
    _ => Err(HttpError::forbidden(
      AUTHORIZATION_DENIED,
      "Approve CLI logins from the Admin UI.",
    )),
  }
}

pub async fn methods(state: &AppState) -> Result<AuthMethodsResponse, HttpError> {
  let policy = crate::modules::sso::service::policy(state).await?;
  Ok(AuthMethodsResponse {
    // Root keeps password login when single sign-on is required; clients
    // still offer it, just not as the default.
    password: !policy.require_sso,
    password_form: !(policy.enabled_name.is_some() && policy.hide_password_form),
    sso: policy.enabled_name.map(|name| SsoMethod { name }),
    cli_browser: true,
  })
}

pub async fn start(
  state: &AppState,
  identity: Option<&AuthIdentity>,
  request: DeviceStartRequest,
) -> Result<DeviceStartResponse, HttpError> {
  // A confirmation is for the CLI session making the request, so it needs
  // one; a login needs nothing.
  let target_session = match request.purpose.unwrap_or_default() {
    DevicePurpose::Login => None,
    DevicePurpose::Reauth => match identity {
      Some(AuthIdentity::Admin {
        kind: SessionKind::Cli,
        session_id,
        ..
      }) => Some(session_id.as_str()),
      _ => {
        return Err(HttpError::forbidden(
          AUTHORIZATION_DENIED,
          "Only a signed-in CLI session can ask for browser confirmation.",
        ));
      }
    },
  };
  let purpose = if target_session.is_some() {
    "reauth"
  } else {
    "login"
  };
  let now = Utc::now();
  let expires_at = now + Duration::minutes(CLI_DEVICE_CODE_MINUTES);
  let hostname = sanitize_hostname(request.hostname.as_deref());
  let ip_address = client_ip::current().map(|address| address.to_string());
  let device_code = token::generate(DEVICE_CODE_PREFIX).map_err(|_| HttpError::internal())?;

  let mut tx = state.db.pool().begin().await?;
  // Expired rows stay for an hour so a late poll still reads "expired"
  // rather than "invalid", then this recurring path removes them.
  sqlx::query("DELETE FROM cli_device_requests WHERE expires_at < ?")
    .bind((now - Duration::hours(1)).to_rfc3339())
    .execute(&mut *tx)
    .await?;
  let pending: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM cli_device_requests WHERE status='pending' AND expires_at > ?",
  )
  .bind(now.to_rfc3339())
  .fetch_one(&mut *tx)
  .await?;
  let pending_here: i64 = sqlx::query_scalar(
    "SELECT COUNT(*) FROM cli_device_requests WHERE status='pending' AND expires_at > ? AND client_ip IS ?",
  )
  .bind(now.to_rfc3339())
  .bind(&ip_address)
  .fetch_one(&mut *tx)
  .await?;
  if pending >= MAX_PENDING_CLI_DEVICE_REQUESTS
    || pending_here >= MAX_PENDING_CLI_DEVICE_REQUESTS_PER_CLIENT
  {
    return Err(rate_limited());
  }

  // A user code collision is unlikely (20^8 codes), but retry rather than
  // fail the login when one happens.
  let mut user_code = None;
  for _ in 0..3 {
    let candidate = generate_user_code()?;
    let inserted = sqlx::query("INSERT INTO cli_device_requests(id,device_code_hash,user_code_hash,status,purpose,target_session_id,client_hostname,client_ip,created_at,expires_at) VALUES(?,?,?,'pending',?,?,?,?,?,?) ON CONFLICT(user_code_hash) DO NOTHING")
      .bind(token::public_id(DEVICE_REQUEST_ID_PREFIX))
      .bind(token::hash(&device_code))
      .bind(token::hash(&candidate))
      .bind(purpose)
      .bind(target_session)
      .bind(&hostname)
      .bind(&ip_address)
      .bind(now.to_rfc3339())
      .bind(expires_at.to_rfc3339())
      .execute(&mut *tx)
      .await?
      .rows_affected();
    if inserted == 1 {
      user_code = Some(candidate);
      break;
    }
  }
  let user_code = user_code.ok_or_else(HttpError::internal)?;
  tx.commit().await?;

  let user_code = display_user_code(&user_code);
  let verification_uri = format!(
    "{}{CLI_APPROVE_PAGE}",
    state.config.public_url.trim_end_matches('/')
  );
  Ok(DeviceStartResponse {
    verification_uri_complete: format!("{verification_uri}?code={user_code}"),
    verification_uri,
    device_code,
    user_code,
    expires_in: CLI_DEVICE_CODE_MINUTES * 60,
    interval: CLI_DEVICE_POLL_INTERVAL_SECONDS,
  })
}

pub async fn poll(
  state: &AppState,
  device_code: &str,
) -> Result<DeviceTokenResponse, HttpError> {
  let now = Utc::now();
  let row: Option<DeviceRow> = sqlx::query_as(
    "SELECT id,status,expires_at,last_polled_at FROM cli_device_requests WHERE device_code_hash=?",
  )
  .bind(token::hash(device_code))
  .fetch_optional(state.db.pool())
  .await?;
  let row = row.ok_or_else(invalid_code)?;
  match row.status.as_str() {
    "consumed" | "cancelled" => return Err(invalid_code()),
    "denied" => {
      return Err(HttpError::forbidden(
        DEVICE_ACCESS_DENIED,
        "The login request was denied in the browser.",
      ));
    }
    _ => {}
  }
  if now >= parse_time(&row.expires_at)? {
    return Err(HttpError::new(
      StatusCode::GONE,
      DEVICE_CODE_EXPIRED,
      "The login request expired before it was approved. Run `dopbase login` again.",
    ));
  }

  if row.status == "pending" {
    let too_fast = match &row.last_polled_at {
      // Half a second of slack absorbs timer jitter on the client.
      Some(last) => {
        now - parse_time(last)?
          < Duration::seconds(CLI_DEVICE_POLL_INTERVAL_SECONDS) - Duration::milliseconds(500)
      }
      None => false,
    };
    sqlx::query("UPDATE cli_device_requests SET last_polled_at=? WHERE id=?")
      .bind(now.to_rfc3339())
      .bind(&row.id)
      .execute(state.db.pool())
      .await?;
    return Ok(DeviceTokenResponse {
      status: if too_fast {
        DevicePollStatus::SlowDown
      } else {
        DevicePollStatus::Pending
      },
      session: None,
    });
  }

  let mut tx = state.db.pool().begin().await?;
  // The status check and the flip happen in one statement, so two polls
  // racing on the same approved code cannot both receive a session.
  let approved: Option<(Option<String>, String, Option<String>)> = sqlx::query_as(
    "UPDATE cli_device_requests SET status='consumed' WHERE id=? AND status='approved' RETURNING approved_by,purpose,target_session_id",
  )
  .bind(&row.id)
  .fetch_optional(&mut *tx)
  .await?;
  let (approved_by, purpose, target_session) = approved.ok_or_else(invalid_code)?;
  let admin_id = approved_by.ok_or_else(invalid_code)?;
  let (email, role_value): (String, String) =
    sqlx::query_as("SELECT email,role FROM admins WHERE id=?")
      .bind(&admin_id)
      .fetch_optional(&mut *tx)
      .await?
      .ok_or_else(invalid_code)?;
  let role = match role_value.as_str() {
    "root" => AdminRole::Root,
    "admin" => AdminRole::Admin,
    "member" => AdminRole::Member,
    _ => return Err(HttpError::internal()),
  };
  if purpose == "reauth" {
    let confirmed = sqlx::query(
      "UPDATE sessions SET recent_auth_at=? WHERE id=? AND admin_id=? AND revoked_at IS NULL",
    )
    .bind(now.to_rfc3339())
    .bind(&target_session)
    .bind(&admin_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if confirmed == 0 {
      return Err(invalid_code());
    }
    common::audit(
      &mut tx,
      role.audit_actor_type(),
      Some(&admin_id),
      Some(&email),
      "admin.reauthenticated",
      None,
      None,
      Some("session"),
      target_session.as_deref(),
      serde_json::json!({"method":"browser","requestId":row.id}),
    )
    .await?;
    tx.commit().await?;
    return Ok(DeviceTokenResponse {
      status: DevicePollStatus::Approved,
      session: None,
    });
  }
  let session = issue_session(&mut tx, &admin_id, SessionKind::Cli).await?;
  common::audit(
    &mut tx,
    role.audit_actor_type(),
    Some(&admin_id),
    Some(&email),
    "login.succeeded",
    None,
    None,
    Some("session"),
    Some(&session.id),
    serde_json::json!({"kind":"cli","method":"browser","requestId":row.id}),
  )
  .await?;
  tx.commit().await?;
  Ok(DeviceTokenResponse {
    status: DevicePollStatus::Approved,
    session: Some(LoginResponse {
      admin_id,
      email,
      role,
      session_kind: SessionKind::Cli,
      token: Some(session.token),
      csrf_token: None,
      last_login_at: Some(session.created_at.to_rfc3339()),
    }),
  })
}

/// Cancelling an unknown or finished request is not an error, so the
/// endpoint says nothing about which device codes exist.
pub async fn cancel(
  state: &AppState,
  device_code: &str,
) -> Result<(), HttpError> {
  sqlx::query("UPDATE cli_device_requests SET status='cancelled',decided_at=? WHERE device_code_hash=? AND status IN ('pending','approved')")
    .bind(Utc::now().to_rfc3339())
    .bind(token::hash(device_code))
    .execute(state.db.pool())
    .await?;
  Ok(())
}

/// Count a wrong user code against the approving session. User codes are
/// short, so guessing has to stay expensive.
async fn user_code_hash(
  state: &AppState,
  session_id: &str,
  user_code: &str,
) -> Result<(String, Vec<u8>), HttpError> {
  let limit_key = format!("cli_user_code:{session_id}");
  if !state.rate_limiter.check(&limit_key).await {
    return Err(rate_limited());
  }
  match normalize_user_code(user_code) {
    Some(code) => Ok((limit_key, token::hash(&code))),
    None => {
      state.rate_limiter.failure(&limit_key).await;
      Err(unknown_user_code())
    }
  }
}

pub async fn inspect(
  state: &AppState,
  identity: &AuthIdentity,
  user_code: &str,
) -> Result<DeviceRequestDetails, HttpError> {
  let (admin_id, _, session_id) = require_browser_human(identity)?;
  let (limit_key, hash) = user_code_hash(state, session_id, user_code).await?;
  let details: Option<PendingRow> = sqlx::query_as(
    &format!("SELECT client_hostname,client_ip,created_at,expires_at,purpose FROM cli_device_requests WHERE user_code_hash=? AND status='pending' AND expires_at > ? AND {OWNED_BY_APPROVER}"),
  )
  .bind(hash)
  .bind(Utc::now().to_rfc3339())
  .bind(admin_id)
  .fetch_optional(state.db.pool())
  .await?;
  let Some(row) = details else {
    state.rate_limiter.failure(&limit_key).await;
    return Err(unknown_user_code());
  };
  Ok(DeviceRequestDetails {
    hostname: row.client_hostname,
    ip_address: row.client_ip,
    created_at: row.created_at,
    expires_at: row.expires_at,
    purpose: if row.purpose == "reauth" {
      DevicePurpose::Reauth
    } else {
      DevicePurpose::Login
    },
  })
}

pub async fn decide(
  state: &AppState,
  identity: &AuthIdentity,
  user_code: &str,
  approve: bool,
) -> Result<(), HttpError> {
  let (admin_id, email, session_id) = require_browser_human(identity)?;
  if approve {
    require_recent_browser_auth(identity)?;
  }
  let (limit_key, hash) = user_code_hash(state, session_id, user_code).await?;
  let now = Utc::now().to_rfc3339();
  let mut tx = state.db.pool().begin().await?;
  let decided: Option<(String, Option<String>)> = sqlx::query_as(
    &format!("UPDATE cli_device_requests SET status=?,approved_by=?,decided_at=? WHERE user_code_hash=? AND status='pending' AND expires_at > ? AND {OWNED_BY_APPROVER} RETURNING id,client_hostname"),
  )
  .bind(if approve { "approved" } else { "denied" })
  .bind(approve.then_some(admin_id))
  .bind(&now)
  .bind(hash)
  .bind(&now)
  .bind(admin_id)
  .fetch_optional(&mut *tx)
  .await?;
  let Some((request_id, hostname)) = decided else {
    drop(tx);
    state.rate_limiter.failure(&limit_key).await;
    return Err(unknown_user_code());
  };
  common::audit(
    &mut tx,
    identity.audit_actor_type(),
    Some(admin_id),
    Some(email),
    if approve {
      "cli_login.approved"
    } else {
      "cli_login.denied"
    },
    None,
    None,
    Some("cli_device_request"),
    Some(&request_id),
    serde_json::json!({"hostname":hostname}),
  )
  .await?;
  tx.commit().await?;
  state.rate_limiter.clear(&limit_key).await;
  Ok(())
}
