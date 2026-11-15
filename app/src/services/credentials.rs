//! The credential module: from a raw credential to the principal behind it.
//! Sessions, personal tokens and runner tokens are each looked up here, and
//! each is checked against today's rules on every use, not only when it was
//! issued:
//!
//! - a session's idle and absolute limits, and the account still active;
//! - a personal token's account still active, its role still allowing
//!   tokens of that kind, its level capped by the role's token level and
//!   its life by the role's longest lifetime, and an AI agent's owner still
//!   active and still allowed to run agents;
//! - a runner token's maker still active.
//!
//! The HTTP extractor only finds the credential in the request and calls
//! [`resolve`].

use chrono::{Duration, Utc};

use crate::{
  constants::{
    errors::AUTHENTICATION_INVALID,
    limits::{BROWSER_SESSION_IDLE_HOURS, CLI_SESSION_IDLE_DAYS, RUNNER_LAST_USED_SECONDS},
  },
  http::HttpError,
  models::{AdminRole, AuthIdentity, SessionKind},
  services::{
    authx::{self, Capability},
    token,
  },
  state::AppState,
  utils::time::Stamp,
};

#[derive(sqlx::FromRow)]
struct SessionRow {
  session_id: String,
  admin_id: String,
  email: String,
  role: String,
  kind: String,
  csrf_hash: Option<Vec<u8>>,
  created_at: String,
  idle_expires_at: String,
  absolute_expires_at: String,
  recent_auth_at: String,
}

#[derive(sqlx::FromRow)]
struct PersonalTokenRow {
  token_id: String,
  token_name: String,
  scope: String,
  project_id: Option<String>,
  environment_id: Option<String>,
  level: String,
  admin_id: String,
  email: String,
  owner_id: Option<String>,
  created_at: String,
  last_used_at: Option<String>,
  /// The account's role's token rules, as they are now.
  token_scope: Option<String>,
  token_max_level: Option<String>,
  token_max_ttl_days: Option<i64>,
}

/// Why a personal token no longer works under its account's role today.
/// The role decides on every use, so changing it takes effect at once.
fn token_refused(
  token: &PersonalTokenRow,
  access: &authx::Access,
  now: chrono::DateTime<Utc>,
) -> Option<&'static str> {
  if !access.has(Capability::TokensPersonal) {
    return Some("This account's role can no longer hold personal tokens.");
  }
  let audit_token = token.scope == "audit";
  match token.token_scope.as_deref() {
    Some("data") if !audit_token => {}
    Some("audit") if audit_token => {}
    _ => return Some("This account's role no longer allows this kind of token."),
  }
  // The role's longest lifetime, counted from when the token was made. A
  // creation time that can't be read can't be checked, so the token is
  // refused rather than let through.
  let Ok(made) = chrono::DateTime::parse_from_rfc3339(&token.created_at) else {
    return Some("This token's creation time can't be read. Create a new one.");
  };
  let longest = Duration::days(token.token_max_ttl_days.unwrap_or(365));
  if now >= made.with_timezone(&Utc) + longest {
    return Some("This token is older than its role allows. Create a new one.");
  }
  None
}

fn parse_role(value: &str) -> Result<AdminRole, HttpError> {
  match value {
    "root" => Ok(AdminRole::Root),
    "admin" => Ok(AdminRole::Admin),
    "member" => Ok(AdminRole::Member),
    "ai_agent" => Ok(AdminRole::AiAgent),
    _ => Err(HttpError::unauthorized(
      AUTHENTICATION_INVALID,
      "The account role is invalid.",
    )),
  }
}

/// Whether a credential's last use was recorded within the last minute.
fn recently(
  last_used_at: Option<&str>,
  now: chrono::DateTime<Utc>,
) -> bool {
  last_used_at
    .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
    .is_some_and(|at| now.signed_duration_since(at) < Duration::seconds(RUNNER_LAST_USED_SECONDS))
}

/// The principal behind a raw credential. `cookie_auth` says it came from
/// the session cookie, which only browser sessions may use.
pub async fn resolve(
  state: &AppState,
  raw_token: &str,
  cookie_auth: bool,
) -> Result<AuthIdentity, HttpError> {
  let hash = token::hash(raw_token);
  let now = Utc::now();

  let session: Option<SessionRow> = sqlx::query_as(concat!(
      "SELECT s.id AS session_id, a.id AS admin_id, u.email, ",
      crate::legacy_role_sql!("a"),
      " AS role, s.kind, s.csrf_hash, s.created_at, s.idle_expires_at, s.absolute_expires_at, s.recent_auth_at FROM sessions s JOIN users u ON u.id = s.user_id JOIN accounts a ON a.id = u.id WHERE s.token_hash = $1 AND s.revoked_at IS NULL"
    ))
    .bind(&hash)
    .fetch_optional(state.db.pool())
    .await
    .map_err(HttpError::from)?;
  if let Some(session) = session {
    let created_at = chrono::DateTime::parse_from_rfc3339(&session.created_at)
      .map_err(|_| HttpError::internal())?
      .with_timezone(&Utc);
    let idle = chrono::DateTime::parse_from_rfc3339(&session.idle_expires_at)
      .map_err(|_| HttpError::internal())?
      .with_timezone(&Utc);
    let absolute = chrono::DateTime::parse_from_rfc3339(&session.absolute_expires_at)
      .map_err(|_| HttpError::internal())?
      .with_timezone(&Utc);
    if now >= idle || now >= absolute {
      return Err(HttpError::unauthorized(
        AUTHENTICATION_INVALID,
        "Your session has expired.",
      ));
    }
    let recent_auth_at = chrono::DateTime::parse_from_rfc3339(&session.recent_auth_at)
      .map_err(|_| HttpError::internal())?
      .with_timezone(&Utc);
    let session_kind = if session.kind == "browser" {
      SessionKind::Browser
    } else {
      SessionKind::Cli
    };
    if cookie_auth && session_kind != SessionKind::Browser {
      return Err(HttpError::unauthorized(
        AUTHENTICATION_INVALID,
        "The session type is invalid.",
      ));
    }
    // The idle deadline never passes the absolute one.
    let next_idle = (now
      + if session_kind == SessionKind::Browser {
        Duration::hours(BROWSER_SESSION_IDLE_HOURS)
      } else {
        Duration::days(CLI_SESSION_IDLE_DAYS)
      })
    .min(absolute);
    sqlx::query("UPDATE sessions SET last_used_at = $1, idle_expires_at = $2 WHERE id = $3")
      .bind(now.stamp())
      .bind(next_idle.stamp())
      .bind(&session.session_id)
      .execute(state.db.pool())
      .await
      .map_err(HttpError::from)?;
    let mut conn = state.db.pool().acquire().await.map_err(HttpError::from)?;
    let access = authx::load_access(&mut conn, &session.admin_id, &state.config.features)
      .await
      .map_err(HttpError::from)?
      .ok_or_else(|| HttpError::unauthorized(AUTHENTICATION_INVALID, "The account is disabled."))?;
    if access.sign_in == authx::SignIn::TokenOnly {
      return Err(HttpError::unauthorized(
        AUTHENTICATION_INVALID,
        "This account signs in with tokens only.",
      ));
    }
    return Ok(AuthIdentity::Admin {
      access,
      admin_id: session.admin_id,
      email: session.email,
      role: parse_role(&session.role)?,
      session_id: session.session_id,
      kind: session_kind,
      recent_auth_at,
      created_at,
      csrf_hash: session.csrf_hash,
    });
  }

  let personal: Option<PersonalTokenRow> = sqlx::query_as(
      "SELECT t.id AS token_id, t.name AS token_name, t.scope, t.project_id, t.environment_id, t.level, a.id AS admin_id, a.label AS email, a.owner_id, t.created_at, t.last_used_at, r.token_scope, r.token_max_level, r.token_max_ttl_days FROM personal_tokens t JOIN account_profiles a ON a.id = t.account_id LEFT JOIN roles r ON r.id = a.role_id WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > $2",
    )
    .bind(&hash)
    .bind(now.stamp())
    .fetch_optional(state.db.pool())
    .await
    .map_err(HttpError::from)?;
  if let Some(token) = personal {
    let mut conn = state.db.pool().acquire().await.map_err(HttpError::from)?;
    let disabled = || HttpError::unauthorized(AUTHENTICATION_INVALID, "The account is disabled.");
    let access = authx::load_access(&mut conn, &token.admin_id, &state.config.features)
      .await
      .map_err(HttpError::from)?
      .ok_or_else(disabled)?;
    if let Some(reason) = token_refused(&token, &access, now) {
      return Err(HttpError::unauthorized(AUTHENTICATION_INVALID, reason));
    }
    // An AI agent runs only while its owner is active and may still run
    // agents.
    if let Some(owner_id) = &token.owner_id {
      let owner = authx::load_access(&mut conn, owner_id, &state.config.features)
        .await
        .map_err(HttpError::from)?
        .ok_or_else(disabled)?;
      if !owner.has(Capability::AgentsView) {
        return Err(HttpError::unauthorized(
          AUTHENTICATION_INVALID,
          "This AI agent's owner can no longer run agents.",
        ));
      }
    }
    // A token may be used every second; recording the use once a minute
    // spares the write lock in between.
    if !recently(token.last_used_at.as_deref(), now) {
      sqlx::query("UPDATE personal_tokens SET last_used_at = $1 WHERE id = $2")
        .bind(now.stamp())
        .bind(&token.token_id)
        .execute(&mut *conn)
        .await
        .map_err(HttpError::from)?;
    }
    // Audit tokens reach no project data.
    let audit = token.scope == "audit";
    // The level is capped by what the role allows tokens today.
    let ceiling = token
      .token_max_level
      .as_deref()
      .and_then(authx::Level::parse)
      .unwrap_or(authx::Level::Metadata);
    let (scope, level) =
      match authx::Scope::from_columns(&token.scope, token.project_id, token.environment_id) {
        Some(scope) if !audit => (
          scope,
          authx::Level::parse(&token.level)
            .unwrap_or_default()
            .min(ceiling),
        ),
        _ => (authx::Scope::All, authx::Level::None),
      };
    return Ok(AuthIdentity::Token {
      admin_id: token.admin_id,
      email: token.email,
      token_id: token.token_id,
      token_name: token.token_name,
      access,
      scope,
      level,
      owner_id: token.owner_id,
      audit,
    });
  }

  // A runner token works only while the person who made it is active.
  // Deleting them deletes it; tokens from 0.1.x name no maker.
  let runner: Option<(String, String, Option<String>)> = sqlx::query_as(
      "SELECT t.id, t.environment_id, t.last_used_at FROM runner_tokens t LEFT JOIN accounts c ON c.id = t.created_by WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > $2) AND (t.created_by IS NULL OR c.status = 'active')",
    )
    .bind(&hash)
    .bind(now.stamp())
    .fetch_optional(state.db.pool())
    .await
    .map_err(HttpError::from)?;
  if let Some((token_id, environment_id, last_used_at)) = runner {
    // A runner may poll every few seconds; one write a minute is enough
    // for "last used". Deciding here skips the UPDATE, and the write lock
    // it takes, on the polls in between.
    if !recently(last_used_at.as_deref(), now) {
      sqlx::query("UPDATE runner_tokens SET last_used_at = $1 WHERE id = $2")
        .bind(now.stamp())
        .bind(&token_id)
        .execute(state.db.pool())
        .await
        .map_err(HttpError::from)?;
    }
    return Ok(AuthIdentity::Runner {
      token_id,
      environment_id,
    });
  }
  Err(HttpError::unauthorized(
    AUTHENTICATION_INVALID,
    "The provided credential is invalid.",
  ))
}
