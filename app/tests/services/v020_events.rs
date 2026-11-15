//! The audit event catalog and the change unit. Here to prove the 0.2.0
//! rewrite safe; drop it once end-to-end tests cover the same ground. The
//! category check guards architecture audit B6 and stays.

use app::services::{
  audit_chain,
  change::{Change, Event},
  db::{DbClient, MIGRATOR},
  events::Action,
};

#[tokio::test]
async fn every_event_type_round_trips_through_the_chain() {
  let db = DbClient::connect("sqlite::memory:").await.unwrap();
  MIGRATOR.run(db.pool()).await.unwrap();
  for action in Action::ALL {
    let mut change = Change::begin(db.pool()).await.unwrap();
    change
      .record(Event {
        actor_type: "admin",
        actor_id: Some("usr_x"),
        actor_label: Some("x@dopbase.com"),
        action,
        project_id: None,
        environment_id: None,
        resource_type: None,
        resource_id: None,
        metadata: serde_json::json!({}),
      })
      .await
      .unwrap();
    change.commit().await.unwrap();
  }
  let stored: Vec<String> = sqlx::query_scalar("SELECT action FROM audit_events ORDER BY seq")
    .fetch_all(db.pool())
    .await
    .unwrap();
  assert_eq!(stored.len(), Action::ALL.len());
  for (name, action) in stored.iter().zip(Action::ALL) {
    assert_eq!(Action::parse(name), Some(action));
  }
  let report = audit_chain::verify_against(db.pool(), None).await.unwrap();
  assert!(report.ok, "{:?}", report.broken);
  assert_eq!(report.records, Action::ALL.len() as u64);
}

#[tokio::test]
async fn a_dropped_change_records_nothing() {
  let db = DbClient::connect("sqlite::memory:").await.unwrap();
  MIGRATOR.run(db.pool()).await.unwrap();
  {
    let mut change = Change::begin(db.pool()).await.unwrap();
    change
      .record(Event {
        actor_type: "admin",
        actor_id: None,
        actor_label: None,
        action: Action::ProjectCreated,
        project_id: None,
        environment_id: None,
        resource_type: None,
        resource_id: None,
        metadata: serde_json::json!({}),
      })
      .await
      .unwrap();
  }
  let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_events")
    .fetch_one(db.pool())
    .await
    .unwrap();
  assert_eq!(count, 0);
}

// Architecture audit B6: the backup-age check kept its own list of actions
// that change secrets and missed the ones that write or remove values in
// other ways.
#[test]
fn every_action_that_writes_or_removes_values_counts_as_a_change() {
  for action in [
    Action::ProjectInitialized,
    Action::ProjectDeleted,
    Action::EnvironmentDeleted,
    Action::SecretCreated,
    Action::SecretImported,
    Action::SecretRolledBack,
  ] {
    assert!(action.changes_secret_values(), "{action}");
  }
  for action in [
    Action::SecretRevealed,
    Action::SecretExported,
    Action::ProjectRenamed,
  ] {
    assert!(!action.changes_secret_values(), "{action}");
  }
  assert!(Action::SecretRuntimeAccessed.hands_out_secret_values());
  // Names are unique, so a stored name means one thing.
  let mut names: Vec<&str> = Action::ALL.iter().map(|action| action.as_str()).collect();
  names.sort_unstable();
  names.dedup();
  assert_eq!(names.len(), Action::ALL.len());
}
