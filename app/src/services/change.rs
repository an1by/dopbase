//! The change unit: the one way to open a write that records audit events.
//!
//! It always starts with SQLite's write lock (`BEGIN IMMEDIATE`). The audit
//! chain reads its head and appends in the same transaction, which is only
//! atomic while no other writer can slip in between; a deferred transaction
//! would get the lock only at its first write, and one that reads first can
//! fail to upgrade under a concurrent writer. Events are recorded from the
//! typed catalog in [`crate::services::events`], in the same commit as the
//! change they describe.
//!
//! This is the seam a Postgres adapter would replace: there, the chain head
//! needs a row lock or an advisory lock instead of the single writer.

use std::ops::{Deref, DerefMut};

use serde_json::Value;
use sqlx::{Sqlite, SqliteConnection, SqlitePool, Transaction};

use super::{
  audit_chain::{self, AuditEntry},
  events::Action,
};
use crate::utils::time::Stamp;

/// One audit event: who did what, to what.
pub struct Event<'a> {
  pub actor_type: &'a str,
  pub actor_id: Option<&'a str>,
  pub actor_label: Option<&'a str>,
  pub action: Action,
  pub project_id: Option<&'a str>,
  pub environment_id: Option<&'a str>,
  pub resource_type: Option<&'a str>,
  pub resource_id: Option<&'a str>,
  pub metadata: Value,
}

/// Appends `event` to the audit chain on `connection`, which must hold the
/// write lock. The client address comes from the current request, when
/// there is one.
pub async fn record_on(
  connection: &mut SqliteConnection,
  event: Event<'_>,
) -> Result<(), sqlx::Error> {
  let metadata = event.metadata.to_string();
  let created_at = chrono::Utc::now().stamp();
  let ip_address = super::client_ip::current().map(|address| address.to_string());
  audit_chain::append(
    connection,
    &AuditEntry {
      id: &super::token::public_id("aud_"),
      actor_type: event.actor_type,
      actor_id: event.actor_id,
      actor_label: event.actor_label,
      action: event.action.as_str(),
      project_id: event.project_id,
      environment_id: event.environment_id,
      resource_type: event.resource_type,
      resource_id: event.resource_id,
      ip_address: ip_address.as_deref(),
      metadata: &metadata,
      created_at: &created_at,
    },
  )
  .await
}

/// An open write. Dereferences to the connection, so repositories take it
/// as `&mut SqliteConnection`. Dropping it without [`Change::commit`] rolls
/// everything back, events included.
pub struct Change {
  tx: Transaction<'static, Sqlite>,
}

impl Change {
  /// Opens a write holding the write lock from its first statement.
  pub async fn begin(pool: &SqlitePool) -> Result<Self, sqlx::Error> {
    Ok(Self {
      tx: pool.begin_with("BEGIN IMMEDIATE").await?,
    })
  }

  /// Records an event, committed with the change or not at all.
  pub async fn record(
    &mut self,
    event: Event<'_>,
  ) -> Result<(), sqlx::Error> {
    record_on(&mut self.tx, event).await
  }

  /// Commits the change and its events together.
  pub async fn commit(self) -> Result<(), sqlx::Error> {
    self.tx.commit().await
  }

  /// Ends a unit that only read under the lock, writing nothing.
  pub async fn rollback(self) -> Result<(), sqlx::Error> {
    self.tx.rollback().await
  }
}

impl Deref for Change {
  type Target = SqliteConnection;

  fn deref(&self) -> &SqliteConnection {
    &self.tx
  }
}

impl DerefMut for Change {
  fn deref_mut(&mut self) -> &mut SqliteConnection {
    &mut self.tx
  }
}
