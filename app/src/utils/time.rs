//! The one shape every stored timestamp takes: UTC, milliseconds, `Z`,
//! for example `2026-11-07T09:30:00.000Z`. At a fixed width, comparing the
//! text compares the times, in SQLite and Postgres alike, so expiry checks
//! can stay in SQL.

use chrono::{DateTime, SecondsFormat, Utc};

/// Formats a time the way the database stores it.
pub trait Stamp {
  fn stamp(&self) -> String;
}

impl Stamp for DateTime<Utc> {
  fn stamp(&self) -> String {
    self.to_rfc3339_opts(SecondsFormat::Millis, true)
  }
}

/// The current time, as stored.
pub fn now() -> String {
  Utc::now().stamp()
}
