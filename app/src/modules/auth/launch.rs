//! Sign in with a launch passcode from `dopbase admin passcode`. Someone on
//! the server machine mints the passcode; the Admin UI's `/launch` page
//! trades it here for a browser session. The passcode is the only proof, so
//! every way it can fail gets the same answer.

use super::{model::*, repository, service::issue_session};
use crate::utils::time::Stamp;
use crate::{
  constants::errors::{PASSCODE_INVALID, RATE_LIMITED},
  http::HttpError,
  models::{AdminRole, AuthIdentity, SessionKind},
  modules::common,
  services::{
    authx, client_ip,
    passcodes::{self, Consumed, PasscodePurpose},
  },
  state::AppState,
  utils::passcode,
};
use axum::http::StatusCode;
use chrono::Utc;

const PURPOSE: PasscodePurpose = PasscodePurpose::Launch;

pub struct LaunchResult {
  pub response: LoginResponse,
  pub cookie_token: String,
}

fn invalid() -> HttpError {
  HttpError::unauthorized(
    PASSCODE_INVALID,
    "This launch link is invalid or has expired. Run `dopbase admin passcode` again on the server.",
  )
}

/// Why a launch was refused, for the audit record only. The caller always
/// answers [`invalid`].
fn reason(consumed: Consumed) -> &'static str {
  match consumed {
    Consumed::Used => "account_refused",
    Consumed::Wrong => "passcode_wrong",
    Consumed::Burned => "passcode_burned",
    Consumed::Expired => "passcode_expired",
    Consumed::Missing => "passcode_missing",
  }
}

pub async fn launch(
  state: &AppState,
  current: Option<&AuthIdentity>,
  request: LaunchRequest,
) -> Result<LaunchResult, HttpError> {
  // A malformed email can't match an account, so it fails like any other.
  let email = common::validate_email(&request.identity).map_err(|_| invalid())?;
  let address = client_ip::current().map_or_else(|| "unknown".to_owned(), |ip| ip.to_string());
  // Keyed on the address too, so someone elsewhere who knows the email
  // can't lock its owner out of the one way in that needs no password.
  let limit_key = format!("launch:{address}:{email}");
  let Some(attempt) = state.rate_limiter.reserve(&limit_key).await else {
    return Err(HttpError::new(
      StatusCode::TOO_MANY_REQUESTS,
      RATE_LIMITED,
      "Too many tries. Please try again later.",
    ));
  };
  let code = passcode::normalize(&request.passcode);
  let now = Utc::now();

  let account = repository::admin_by_email(state.db.pool(), &email).await?;
  // Tries against an account with no code cost the email nothing, and new
  // emails cost nothing either, so the address pays for them instead. Once
  // its misses run out they stop taking the write lock or adding audit
  // events. A code that is waiting is never held back by this. The budget
  // is reserved before any work, so parallel misses can't all slip past
  // it, and IPv6 clients share one budget per /64.
  let waiting = match &account {
    Some((admin_id, ..)) => {
      let mut connection = state.db.pool().acquire().await?;
      passcodes::pending(&mut connection, PURPOSE, admin_id).await?
    }
    None => false,
  };
  let miss = if waiting {
    None
  } else {
    let miss_key = format!("launch-miss:{}", client_ip::bucket(client_ip::current()));
    match state.rate_limiter.reserve(&miss_key).await {
      Some(miss) => Some(miss),
      None => return Err(invalid()),
    }
  };
  // Take the write lock now: the steps below read before they write, and a
  // deferred transaction can't always upgrade under a concurrent writer.
  let mut tx = crate::services::change::Change::begin(state.db.pool()).await?;
  let consumed = match &account {
    Some((admin_id, ..)) => {
      passcodes::consume(&mut tx, PURPOSE, admin_id, code.as_deref(), now).await?
    }
    None => Consumed::Missing,
  };

  // The account may have changed since the passcode was issued, so check it
  // again: still enabled, still a person, still allowed past single sign-on.
  let allowed = match (&account, consumed) {
    (Some((admin_id, ..)), Consumed::Used) => {
      let access = authx::load_access(&mut tx, admin_id, &state.config.features).await?;
      authx::sign_in_refusal(access.as_ref(), || async {
        Ok::<_, HttpError>(
          crate::modules::sso::service::policy(state)
            .await?
            .require_sso,
        )
      })
      .await?
      .is_none()
    }
    _ => false,
  };

  if !allowed {
    // Only failures sweep, and nothing else does: no timer, no CLI run.
    passcodes::sweep_expired(&mut tx, now).await?;
    // Like a wrong password: nobody proved who they are, so the record
    // names only the email that was tried.
    common::audit(
      &mut tx,
      "anonymous",
      None,
      Some(&email),
      crate::services::events::Action::LoginFailed,
      None,
      None,
      None,
      None,
      serde_json::json!({"method":"passcode","reason":reason(consumed)}),
    )
    .await?;
    tx.commit().await?;
    // With no live code there is nothing to guess, so the email pays
    // nothing; the address pays for the wasted work. A code that turned
    // up after the check above counts against the email as usual.
    match (consumed, miss) {
      (Consumed::Missing, Some(miss)) => {
        miss.fail();
        attempt.release();
      }
      (Consumed::Missing, None) => attempt.release(),
      (_, miss) => {
        attempt.fail();
        if let Some(miss) = miss {
          miss.release();
        }
      }
    }
    return Err(invalid());
  }

  let (admin_id, email, _, role_value) = account.expect("checked above");
  let role = AdminRole::parse(&role_value).ok_or_else(HttpError::internal)?;
  // Switching accounts in a browser leaves nothing behind.
  if let Some(AuthIdentity::Admin {
    kind: SessionKind::Browser,
    session_id,
    ..
  }) = current
  {
    repository::revoke_session(&mut tx, session_id, &now.stamp()).await?;
  }
  let session = issue_session(&mut tx, &admin_id, SessionKind::Browser).await?;
  common::audit(
    &mut tx,
    role.audit_actor_type(),
    Some(&admin_id),
    Some(&email),
    crate::services::events::Action::LoginSucceeded,
    None,
    None,
    Some("session"),
    Some(&session.id),
    serde_json::json!({"kind":"browser","method":"passcode"}),
  )
  .await?;
  tx.commit().await?;
  attempt.succeed();
  drop(miss);
  Ok(LaunchResult {
    response: LoginResponse {
      admin_id,
      email,
      role,
      session_kind: SessionKind::Browser,
      token: None,
      csrf_token: session.csrf,
      last_login_at: Some(session.created_at.stamp()),
    },
    cookie_token: session.token,
  })
}
