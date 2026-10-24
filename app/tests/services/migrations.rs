use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::NaiveDateTime;
use regex::Regex;

fn migrations_dir() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations")
}

fn migration_files() -> Vec<String> {
  let mut names: Vec<String> = fs::read_dir(migrations_dir())
    .unwrap()
    .map(|entry| entry.unwrap().file_name().into_string().unwrap())
    .filter(|name| name.ends_with(".sql"))
    .collect();
  names.sort();
  names
}

#[test]
fn database_migration_files_follow_the_naming_convention() {
  let timestamped = Regex::new(r"^([0-9]{14})_([a-z0-9_]+)\.(up|down)\.sql$").unwrap();

  for name in migration_files() {
    let captures = timestamped
      .captures(&name)
      .unwrap_or_else(|| panic!("{name}: expected YYYYMMDDHHMMSS_<name>.up.sql or .down.sql"));
    let version: i64 = captures[1].parse().unwrap();
    assert!(version > 0, "{name}: version must be positive");
    NaiveDateTime::parse_from_str(&captures[1], "%Y%m%d%H%M%S")
      .unwrap_or_else(|_| panic!("{name}: version is not a valid UTC timestamp"));
  }
}

#[test]
fn every_migration_file_has_a_matching_pair() {
  let directory = migrations_dir();
  let mut pairs = BTreeSet::new();
  for name in migration_files() {
    let pair = name
      .strip_suffix(".up.sql")
      .or_else(|| name.strip_suffix(".down.sql"))
      .unwrap_or_else(|| panic!("{name}: expected an .up.sql or .down.sql suffix"));
    pairs.insert(pair.to_owned());
  }

  for pair in pairs {
    for suffix in ["up", "down"] {
      let file = format!("{pair}.{suffix}.sql");
      assert!(directory.join(&file).is_file(), "{file} is missing");
    }
  }
}
