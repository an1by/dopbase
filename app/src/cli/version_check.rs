//! A warning when the server is a release ahead of this CLI.
//!
//! Every API response names the server's version in `X-Dopbase-Version`.
//! The CLI compares it with its own and warns once per command when the
//! server's major or minor version is higher. Older servers send no header
//! and a patch release ahead stays quiet.

use std::{
  env,
  sync::atomic::{AtomicBool, Ordering},
};

use reqwest::header::HeaderMap;

use super::output;
use crate::{
  constants::{client::VERSION_HEADER, config::ENV_VERSION_WARNING},
  utils::version,
};

static WARNED: AtomicBool = AtomicBool::new(false);

/// The warning for a server a minor or major release ahead of this CLI.
pub fn server_newer_warning(
  server: &str,
  cli: &str,
) -> Option<String> {
  let (server_major, server_minor, _) = version::parse(server)?;
  let (cli_major, cli_minor, _) = version::parse(cli)?;
  ((server_major, server_minor) > (cli_major, cli_minor)).then(|| {
    format!("The server runs Dopbase {server} and this CLI is {cli}. Run `dopbase update`.")
  })
}

/// Whether `DOPBASE_VERSION_WARNING` leaves the warning on. Only `false`
/// turns it off.
pub fn warning_enabled(value: Option<&str>) -> bool {
  !value.is_some_and(|value| value.trim().eq_ignore_ascii_case("false"))
}

/// Print the warning the first time a response shows a newer server.
pub(crate) fn note(headers: &HeaderMap) {
  let Some(server) = headers
    .get(VERSION_HEADER)
    .and_then(|value| value.to_str().ok())
  else {
    return;
  };
  let Some(message) = server_newer_warning(server, env!("CARGO_PKG_VERSION")) else {
    return;
  };
  if !warning_enabled(env::var(ENV_VERSION_WARNING).ok().as_deref())
    || WARNED.swap(true, Ordering::Relaxed)
  {
    return;
  }
  output::print_warning(&message);
}
