//! Which CLI version is calling, read from its User-Agent.
//!
//! Only a User-Agent of the form `dopbase/X.Y.Z` names a CLI version.
//! Browsers, scripts, 0.1.x CLIs (which send no User-Agent) and anything
//! that can't be parsed always pass. Anyone can set this header, so it gives
//! honest clients a clear message and is never an access check.

use axum::http::{HeaderMap, header};

use crate::{
  constants::errors::CLI_UPGRADE_REQUIRED,
  http::HttpError,
  utils::version::{self, Version},
};

/// The version a Dopbase CLI sent, or `None` for any other caller.
pub fn cli_version(user_agent: Option<&str>) -> Option<Version> {
  let rest = user_agent?.strip_prefix("dopbase/")?;
  version::parse(rest.split_whitespace().next()?)
}

/// Whether this caller may use something that needs CLI `min` or newer.
/// Only a CLI that names an older version falls short.
pub fn cli_supports(
  user_agent: Option<&str>,
  min: Version,
) -> bool {
  cli_version(user_agent).is_none_or(|version| version >= min)
}

/// `400 CLI_UPGRADE_REQUIRED` when the caller is a CLI older than `min`.
pub fn require_cli(
  headers: &HeaderMap,
  min: Version,
) -> Result<(), HttpError> {
  let user_agent = headers
    .get(header::USER_AGENT)
    .and_then(|value| value.to_str().ok());
  match cli_version(user_agent) {
    Some(found) if found < min => Err(HttpError::bad_request(
      CLI_UPGRADE_REQUIRED,
      &upgrade_message(min, found),
    )),
    _ => Ok(()),
  }
}

/// The refusal a CLI at `found` gets from a route that needs `min`.
pub fn upgrade_message(
  min: Version,
  found: Version,
) -> String {
  format!(
    "This server needs Dopbase CLI {} or newer, and this one is {}. Update it with: curl -fsSL https://dopbase.com/install.sh | sh",
    version::display(min),
    version::display(found)
  )
}
