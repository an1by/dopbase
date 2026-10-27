use crate::{
  constants::config::{
    RUN_CODE_LOADING_NAMES, RUN_RESERVED_NAMES, RUN_SENSITIVE_NAMES, RUN_SHELL_RESERVED_NAMES,
    RUN_SHELL_RESERVED_PREFIXES,
  },
  models::SecretInput,
};
use anyhow::{Result, bail};
use std::collections::HashSet;

#[derive(Debug, Default)]
pub struct SelectionOptions {
  /// Keys to inject. Empty means every stored key.
  pub only: Vec<String>,
  pub allow_missing: bool,
  /// Keys whose existing parent value wins over the stored secret.
  pub preserve_env: Vec<String>,
}

/// The variables to inject and, by name only, what was left out and why.
#[derive(Debug, Default)]
pub struct Selection {
  pub inject: Vec<SecretInput>,
  /// `--only` keys that are not stored (only with `allow_missing`).
  pub missing: Vec<String>,
  /// Reserved names dropped from the payload.
  pub skipped: Vec<String>,
  /// Code-loading names dropped because `--only` did not name them.
  pub blocked: Vec<String>,
  /// Keys left to the parent environment by `--preserve-env`.
  pub preserved: Vec<String>,
  /// Injected names that can change how programs load or run.
  pub dangerous: Vec<String>,
}

/// Filters runtime secrets before the child exists. `parent_has` reports
/// whether the parent environment defines a name.
pub fn select(
  entries: Vec<SecretInput>,
  options: &SelectionOptions,
  parent_has: impl Fn(&str) -> bool,
) -> Result<Selection> {
  let only: HashSet<&str> = options.only.iter().map(String::as_str).collect();
  let preserve: HashSet<&str> = options.preserve_env.iter().map(String::as_str).collect();
  let mut selection = Selection::default();

  let stored: HashSet<&str> = entries.iter().map(|entry| entry.key.as_str()).collect();
  let mut missing: Vec<String> = only
    .iter()
    .filter(|key| !stored.contains(*key))
    .map(|key| (*key).to_owned())
    .collect();
  missing.sort();
  if !missing.is_empty() && !options.allow_missing {
    bail!(
      "--only key(s) not stored in this environment: {}. The child was not started. Pass --allow-missing to run without them.",
      missing.join(", ")
    );
  }
  selection.missing = missing;

  for entry in entries {
    let key = entry.key.as_str();
    if !only.is_empty() && !only.contains(key) {
      continue;
    }
    if is_reserved(key) {
      selection.skipped.push(entry.key);
      continue;
    }
    if preserve.contains(key) && parent_has(key) {
      selection.preserved.push(entry.key);
      continue;
    }
    let code_loading = matches_any(&RUN_CODE_LOADING_NAMES, key);
    if code_loading && !only.contains(key) {
      selection.blocked.push(entry.key);
      continue;
    }
    if code_loading || matches_any(&RUN_SENSITIVE_NAMES, key) {
      selection.dangerous.push(entry.key.clone());
    }
    selection.inject.push(entry);
  }
  Ok(selection)
}

fn matches_any(
  names: &[&str],
  key: &str,
) -> bool {
  names.iter().any(|name| names_match(name, key))
}

fn is_reserved(key: &str) -> bool {
  RUN_RESERVED_NAMES
    .iter()
    .chain(RUN_SHELL_RESERVED_NAMES.iter())
    .any(|name| names_match(name, key))
    || RUN_SHELL_RESERVED_PREFIXES.iter().any(|prefix| {
      key
        .get(..prefix.len())
        .is_some_and(|head| names_match(prefix, head))
    })
}

/// Environment names are case-insensitive on Windows only.
fn names_match(
  name: &str,
  key: &str,
) -> bool {
  if cfg!(windows) {
    name.eq_ignore_ascii_case(key)
  } else {
    name == key
  }
}
