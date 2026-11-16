use std::convert::Infallible;

use axum::{
  extract::FromRequestParts,
  http::{HeaderMap, header, request::Parts},
};
use chrono::{Duration, Utc};

use crate::{
  constants::{
    errors::{AUTHORIZATION_DENIED, CSRF_REQUIRED_MESSAGE},
    limits::RECENT_AUTHENTICATION_MINUTES,
    tokens::CSRF_TOKEN_PREFIX,
  },
  http::HttpError,
  models::{AuthIdentity, SessionKind},
  services::{authx::Capability, token},
  state::AppState,
};

impl FromRequestParts<AppState> for AuthIdentity {
  type Rejection = HttpError;

  async fn from_request_parts(
    parts: &mut Parts,
    state: &AppState,
  ) -> Result<Self, Self::Rejection> {
    let (raw_token, cookie_auth) = credential(&parts.headers).ok_or_else(|| {
      HttpError::unauthorized("AUTHENTICATION_REQUIRED", "Please log in to continue.")
    })?;
    crate::services::credentials::resolve(state, &raw_token, cookie_auth).await
  }
}

fn credential(headers: &HeaderMap) -> Option<(String, bool)> {
  if let Some(value) = headers
    .get(header::AUTHORIZATION)
    .and_then(|value| value.to_str().ok())
    && let Some(value) = value.strip_prefix("Bearer ")
  {
    return Some((value.to_owned(), false));
  }
  let cookies = headers.get(header::COOKIE)?.to_str().ok()?;
  cookies.split(';').map(str::trim).find_map(|cookie| {
    cookie
      .strip_prefix("dopbase_session=")
      .map(|value| (value.to_owned(), true))
  })
}

/// Any person signed in with a session, whatever their role. Tokens are
/// not people.
pub fn require_person(identity: &AuthIdentity) -> Result<(&str, &str), HttpError> {
  match identity {
    AuthIdentity::Admin {
      admin_id, email, ..
    } => Ok((admin_id, email)),
    _ => Err(HttpError::forbidden(
      AUTHORIZATION_DENIED,
      "This operation requires a signed-in account.",
    )),
  }
}

/// A signed-in person whose role holds `capability`. Root holds them all.
pub fn require_capability(
  identity: &AuthIdentity,
  capability: Capability,
) -> Result<(&str, &str), HttpError> {
  match identity {
    AuthIdentity::Admin {
      admin_id,
      email,
      access,
      ..
    } if access.has(capability) => Ok((admin_id, email)),
    _ if Capability::ROOT_ONLY.contains(&capability) => Err(HttpError::forbidden(
      AUTHORIZATION_DENIED,
      "This operation requires the root administrator.",
    )),
    _ => Err(HttpError::forbidden(
      AUTHORIZATION_DENIED,
      "Your role does not allow this operation.",
    )),
  }
}

/// A person signed in to the Admin UI. Changes to who can reach what are
/// made there only, behind CSRF and recent sign-in checks.
pub fn require_browser(identity: &AuthIdentity) -> Result<(&str, &str), HttpError> {
  let result = require_person(identity)?;
  if !matches!(
    identity,
    AuthIdentity::Admin {
      kind: SessionKind::Browser,
      ..
    }
  ) {
    return Err(HttpError::forbidden(
      AUTHORIZATION_DENIED,
      "This operation is available from the Admin UI only.",
    ));
  }
  Ok(result)
}

/// [`require_capability`] from an Admin UI session only.
pub fn require_capability_browser(
  identity: &AuthIdentity,
  capability: Capability,
) -> Result<(&str, &str), HttpError> {
  let result = require_capability(identity, capability)?;
  require_browser(identity)?;
  Ok(result)
}

/// The account behind a person's session or a personal token, for actions
/// both may take, such as changing secrets their level allows.
pub fn require_account(identity: &AuthIdentity) -> Result<(&str, &str), HttpError> {
  match identity {
    AuthIdentity::Admin {
      admin_id, email, ..
    }
    | AuthIdentity::Token {
      admin_id, email, ..
    } => Ok((admin_id, email)),
    AuthIdentity::Runner { .. } => Err(HttpError::forbidden(
      AUTHORIZATION_DENIED,
      "This operation is not available to runner tokens.",
    )),
  }
}

pub fn require_read_access(identity: &AuthIdentity) -> Result<(), HttpError> {
  match identity {
    AuthIdentity::Admin { .. } | AuthIdentity::Token { .. } => Ok(()),
    AuthIdentity::Runner { .. } => Err(HttpError::forbidden(
      AUTHORIZATION_DENIED,
      "This operation is not available to runner tokens.",
    )),
  }
}

pub fn require_metadata_access(identity: &AuthIdentity) -> Result<(), HttpError> {
  match identity {
    AuthIdentity::Admin { .. } | AuthIdentity::Token { .. } => Ok(()),
    _ => Err(HttpError::forbidden(
      AUTHORIZATION_DENIED,
      "This operation requires an authenticated account.",
    )),
  }
}

pub fn require_mutation(
  identity: &AuthIdentity,
  headers: &HeaderMap,
) -> Result<(), HttpError> {
  require_account(identity)?;
  if let AuthIdentity::Admin {
    kind: SessionKind::Browser,
    csrf_hash,
    ..
  } = identity
  {
    let provided = headers
      .get("x-dopbase-csrf")
      .and_then(|value| value.to_str().ok())
      .ok_or_else(|| HttpError::forbidden(AUTHORIZATION_DENIED, CSRF_REQUIRED_MESSAGE))?;
    let expected = csrf_hash
      .as_ref()
      .ok_or_else(|| HttpError::forbidden(AUTHORIZATION_DENIED, CSRF_REQUIRED_MESSAGE))?;
    let tab = token::tab_csrf(CSRF_TOKEN_PREFIX, expected);
    if token::hash(provided) != *expected && !token::constant_time_eq(provided, &tab) {
      return Err(HttpError::forbidden(
        AUTHORIZATION_DENIED,
        CSRF_REQUIRED_MESSAGE,
      ));
    }
  }
  Ok(())
}

pub fn require_recent_browser_auth(identity: &AuthIdentity) -> Result<(), HttpError> {
  if let AuthIdentity::Admin {
    kind: SessionKind::Browser,
    recent_auth_at,
    ..
  } = identity
    && Utc::now() - *recent_auth_at > Duration::minutes(RECENT_AUTHENTICATION_MINUTES)
  {
    return Err(HttpError::forbidden(
      "RECENT_AUTHENTICATION_REQUIRED",
      "Please confirm your password before continuing.",
    ));
  }
  require_account(identity).map(|_| ())
}

/// A recent sign-in on any session, browser or CLI. For the few actions
/// that hand out or replace everything (the master key, a restore), a
/// stolen CLI token must not be enough: the CLI confirms its session first,
/// which sets the same time the browser's confirmation does.
pub fn require_recent_auth(identity: &AuthIdentity) -> Result<(), HttpError> {
  if let AuthIdentity::Admin { recent_auth_at, .. } = identity
    && Utc::now() - *recent_auth_at > Duration::minutes(RECENT_AUTHENTICATION_MINUTES)
  {
    return Err(HttpError::forbidden(
      "RECENT_AUTHENTICATION_REQUIRED",
      "Please confirm your password before continuing.",
    ));
  }
  // Only a session can show a recent sign-in. A personal token never can.
  require_person(identity).map(|_| ())
}

pub struct OptionalIdentity(pub Option<AuthIdentity>);

impl FromRequestParts<AppState> for OptionalIdentity {
  type Rejection = Infallible;
  async fn from_request_parts(
    parts: &mut Parts,
    state: &AppState,
  ) -> Result<Self, Self::Rejection> {
    Ok(Self(
      AuthIdentity::from_request_parts(parts, state).await.ok(),
    ))
  }
}
