//! Dopbase release versions, as `MAJOR.MINOR.PATCH`.

/// A release version: major, minor and patch.
pub type Version = (u64, u64, u64);

/// Parses `1.2.3` or `v1.2.3`. Pre-release and build suffixes aren't
/// accepted, so they can't be ordered against a release by mistake.
pub fn parse(value: &str) -> Option<Version> {
  let value = value.trim().strip_prefix('v').unwrap_or(value.trim());
  let mut components = value.split('.');
  let major = component(components.next()?)?;
  let minor = component(components.next()?)?;
  let patch = component(components.next()?)?;
  if components.next().is_some() {
    return None;
  }
  Some((major, minor, patch))
}

fn component(value: &str) -> Option<u64> {
  if value.is_empty() || value.bytes().any(|byte| !byte.is_ascii_digit()) {
    return None;
  }
  value.parse().ok()
}

/// `1.2.3`, for messages.
pub fn display((major, minor, patch): Version) -> String {
  format!("{major}.{minor}.{patch}")
}
