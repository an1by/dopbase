//! How the CLI and the server tell each other their versions.

use crate::utils::version::Version;

/// Sent on every CLI request, such as `dopbase/0.2.0`. CLIs before 0.2.0
/// send no User-Agent at all.
pub const USER_AGENT: &str = concat!("dopbase/", env!("CARGO_PKG_VERSION"));

/// The response header that names the server's version on every API
/// response.
pub const VERSION_HEADER: &str = "x-dopbase-version";

/// The oldest CLI the server answers. A CLI that sends no version passes,
/// so 0.1.x CLIs are never refused by this.
pub const MIN_CLI_VERSION: Version = (0, 2, 0);

// A route that needs a newer CLI than the floor gets its own minimum here
// and calls `services::client_version::require_cli` with it, for example
// `pub const RUNTIME_STREAM: Version = (0, 3, 0);`.
