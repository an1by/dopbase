//! The provider presets root picks from on the Single sign-on page.
//!
//! Presets live in `presets.toml` next to this file, which is compiled into
//! the binary and explains each field. Adding a provider means adding a
//! `[[preset]]` block there: the database
//! stores the preset ID as plain text, and the Admin UI reads the list from
//! the settings endpoint. A preset only fills in hints and switches the
//! provider quirks below, so a stored ID that later disappears from the file
//! behaves like the generic preset.

use serde::Deserialize;
use std::{collections::HashSet, sync::OnceLock};

const PRESETS_TOML: &str = include_str!("presets.toml");

/// The preset every provider falls back to. The catalog must contain it.
pub const GENERIC_PRESET: &str = "generic";

/// The standard OpenID Connect claim that marks an email as verified.
pub const STANDARD_EMAIL_VERIFIED_CLAIM: &str = "email_verified";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PresetFile {
  preset: Vec<Preset>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Preset {
  /// Stored in `sso_providers.preset`. Lowercase letters, digits, and dashes.
  pub id: String,
  /// The name in the provider list.
  pub label: String,
  /// The default sign-in button label.
  pub button_label: String,
  /// An example issuer URL, shown as the field's placeholder.
  pub issuer: String,
  /// A setup note shown under the provider list.
  pub hint: String,
  /// The boolean ID token claim that proves the email belongs to the person
  /// signing in. Auto-linking by email needs it to be true.
  #[serde(default = "standard_email_verified_claim")]
  pub email_verified_claim: String,
  /// Whether confirming a sensitive action also sends `prompt=login`.
  /// `max_age=0` is always sent; some providers reject `prompt=login`.
  #[serde(default = "enabled")]
  pub prompt_login: bool,
  /// Issuer path segments that are refused, such as multi-tenant endpoints
  /// whose tokens anyone can get.
  #[serde(default)]
  pub reject_issuer_segments: Vec<String>,
  /// Why an issuer with one of those segments was refused.
  #[serde(default)]
  pub reject_issuer_message: Option<String>,
}

fn standard_email_verified_claim() -> String {
  STANDARD_EMAIL_VERIFIED_CLAIM.to_owned()
}

fn enabled() -> bool {
  true
}

impl Preset {
  /// Whether `issuer` uses a path segment this preset refuses.
  pub fn rejects_issuer(
    &self,
    issuer: &str,
  ) -> bool {
    let issuer = format!("{issuer}/");
    self
      .reject_issuer_segments
      .iter()
      .any(|segment| issuer.contains(segment.as_str()))
  }
}

/// Parse and check the catalog. Exposed so tests can check the file.
pub fn parse(source: &str) -> Result<Vec<Preset>, String> {
  let presets: Vec<Preset> = toml::from_str::<PresetFile>(source)
    .map_err(|error| format!("invalid presets.toml: {error}"))?
    .preset;
  let mut seen = HashSet::new();
  for preset in &presets {
    let id_valid = !preset.id.is_empty()
      && preset
        .id
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !id_valid {
      return Err(format!(
        "preset ID {:?} must use a-z, 0-9, and -",
        preset.id
      ));
    }
    if !seen.insert(preset.id.as_str()) {
      return Err(format!("preset ID {:?} appears twice", preset.id));
    }
    if [
      &preset.label,
      &preset.button_label,
      &preset.issuer,
      &preset.hint,
    ]
    .iter()
    .any(|value| value.trim().is_empty())
    {
      return Err(format!("preset {:?} has an empty field", preset.id));
    }
    if preset.email_verified_claim.trim().is_empty() {
      return Err(format!(
        "preset {:?} has an empty email_verified_claim",
        preset.id
      ));
    }
    if !preset.reject_issuer_segments.is_empty() && preset.reject_issuer_message.is_none() {
      return Err(format!(
        "preset {:?} refuses issuers but has no reject_issuer_message",
        preset.id
      ));
    }
  }
  if !seen.contains(GENERIC_PRESET) {
    return Err(format!(
      "presets.toml must contain the {GENERIC_PRESET:?} preset"
    ));
  }
  Ok(presets)
}

/// Every preset, in the order the Admin UI lists them.
pub fn all() -> &'static [Preset] {
  static CATALOG: OnceLock<Vec<Preset>> = OnceLock::new();
  CATALOG.get_or_init(|| parse(PRESETS_TOML).unwrap_or_else(|error| panic!("{error}")))
}

pub fn find(id: &str) -> Option<&'static Preset> {
  all().iter().find(|preset| preset.id == id)
}

/// The stored preset, or the generic one when the ID is no longer listed.
pub fn resolve(id: &str) -> &'static Preset {
  find(id)
    .or_else(|| find(GENERIC_PRESET))
    .expect("parse() requires the generic preset")
}
