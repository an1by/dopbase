use app::cli::version_check::{server_newer_warning, warning_enabled};

#[test]
fn only_a_server_a_minor_or_major_release_ahead_gets_a_warning() {
  assert_eq!(
    server_newer_warning("0.3.0", "0.2.0").as_deref(),
    Some("The server runs Dopbase 0.3.0 and this CLI is 0.2.0. Run `dopbase update`.")
  );
  assert!(server_newer_warning("1.0.0", "0.2.0").is_some());
  for server in ["0.2.5", "0.2.0", "0.1.10", "garbage", ""] {
    assert_eq!(server_newer_warning(server, "0.2.0"), None, "{server}");
  }
}

#[test]
fn only_false_turns_the_warning_off() {
  for value in [None, Some("true"), Some("1"), Some("")] {
    assert!(warning_enabled(value), "{value:?}");
  }
  for value in [Some("false"), Some("FALSE"), Some(" false ")] {
    assert!(!warning_enabled(value), "{value:?}");
  }
}
