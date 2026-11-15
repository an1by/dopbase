use app::{
  constants::{client::MIN_CLI_VERSION, errors::CLI_UPGRADE_REQUIRED},
  services::client_version::{cli_supports, cli_version, require_cli},
};
use axum::http::{HeaderMap, HeaderValue, header};

#[test]
fn only_a_dopbase_user_agent_names_a_cli_version() {
  for (user_agent, expected) in [
    (Some("dopbase/0.2.0"), Some((0, 2, 0))),
    (Some("dopbase/1.0.0 (linux)"), Some((1, 0, 0))),
    (Some("dopbase/not-a-version"), None),
    (Some("dopbase/0.3.0-rc.1"), None),
    (Some("dopbase/"), None),
    (Some("curl/8.7.1"), None),
    (
      Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
      None,
    ),
    (None, None),
  ] {
    assert_eq!(cli_version(user_agent), expected, "{user_agent:?}");
  }
}

#[test]
fn only_a_cli_that_names_an_older_version_falls_short() {
  for (user_agent, supported) in [
    (None, true),
    (Some("curl/8.7.1"), true),
    (Some("dopbase/not-a-version"), true),
    (Some("dopbase/0.3.0-rc.1"), true),
    (Some("dopbase/0.1.10"), false),
    (Some("dopbase/0.1.9"), false),
    (Some("dopbase/0.2.0"), true),
    (Some("dopbase/0.2.1"), true),
    (Some("dopbase/1.0.0 (linux)"), true),
  ] {
    assert_eq!(
      cli_supports(user_agent, MIN_CLI_VERSION),
      supported,
      "{user_agent:?}"
    );
  }
  // A route with its own minimum refuses CLIs the floor still lets in.
  assert!(!cli_supports(Some("dopbase/0.2.9"), (0, 3, 0)));
  assert!(cli_supports(Some("dopbase/0.3.0"), (0, 3, 0)));
}

#[test]
fn the_refusal_names_both_versions_and_how_to_update() {
  let mut headers = HeaderMap::new();
  headers.insert(
    header::USER_AGENT,
    HeaderValue::from_static("dopbase/0.1.9"),
  );
  let error = require_cli(&headers, MIN_CLI_VERSION).unwrap_err();
  assert_eq!(error.status, 400);
  assert_eq!(
    error.errors[CLI_UPGRADE_REQUIRED],
    "This server needs Dopbase CLI 0.2.0 or newer, and this one is 0.1.9. Update it with: curl -fsSL https://dopbase.com/install.sh | sh"
  );
  assert!(require_cli(&HeaderMap::new(), MIN_CLI_VERSION).is_ok());
}
