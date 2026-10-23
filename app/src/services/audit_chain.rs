//! Tamper-evident hash chain over audit records.
//!
//! Every audit record stores three extra values: its position in the chain
//! (`seq`), the hash of the record before it (`prev_hash`), and the hash of
//! its own stored contents (`record_hash`). Recomputing the hashes in
//! sequence order therefore detects any record that was modified, inserted,
//! or removed after the fact.
//!
//! These invariants keep the chain sound:
//!
//! - Appends read the chain head and insert in the same write transaction,
//!   so SQLite's single-writer lock makes them atomic.
//! - The digest is computed from the values as stored, never from a
//!   re-serialization, so verification hashes exactly what it reads back.
//! - Nothing is ever sealed after the fact. Records written before the chain
//!   existed stay unsequenced and are reported as legacy; any record without
//!   a position that is newer than the chain's genesis fails verification.
//! - Retention archives expired records to the data directory before
//!   deleting them, and leaves an anchor so the surviving records still
//!   verify as one unbroken chain. It runs at startup and then on a timer
//!   ([`spawn_retention`]), never inside the request that writes a record.

use std::{
  fs,
  path::{Path, PathBuf},
  time::Duration,
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqlitePool, sqlite::SqliteConnection};

/// Domain separator, mixed into every digest so audit hashes cannot collide
/// with other SHA-256 uses of the same field values.
const DOMAIN: &str = "dopbase:audit-chain:v1";

/// Records verified per query while walking the chain.
const VERIFY_PAGE: i64 = 500;

/// The record that starts the chain stores no predecessor hash.
pub const GENESIS: &str = "";

/// A record as stored in `audit_events`, including its chain columns.
#[derive(sqlx::FromRow)]
struct Record {
  id: String,
  actor_type: String,
  actor_id: Option<String>,
  actor_label: Option<String>,
  action: String,
  project_id: Option<String>,
  environment_id: Option<String>,
  resource_type: Option<String>,
  resource_id: Option<String>,
  ip_address: Option<String>,
  metadata: String,
  created_at: String,
  seq: Option<i64>,
  prev_hash: Option<String>,
  record_hash: Option<String>,
}

impl Record {
  /// The record as retention archives it: every stored column, chain fields
  /// included, in the same camelCase shape the audit list API returns.
  fn archived(&self) -> Value {
    json!({
      "id": self.id,
      "actorType": self.actor_type,
      "actorId": self.actor_id,
      "actorLabel": self.actor_label,
      "action": self.action,
      "projectId": self.project_id,
      "environmentId": self.environment_id,
      "resourceType": self.resource_type,
      "resourceId": self.resource_id,
      "ipAddress": self.ip_address,
      "metadata": serde_json::from_str::<Value>(&self.metadata)
        .unwrap_or_else(|_| Value::String(self.metadata.clone())),
      "createdAt": self.created_at,
      "seq": self.seq,
      "prevHash": self.prev_hash,
      "recordHash": self.record_hash,
    })
  }

  /// The stored values the chain hashes, borrowed from this record.
  fn entry(&self) -> AuditEntry<'_> {
    AuditEntry {
      id: &self.id,
      actor_type: &self.actor_type,
      actor_id: self.actor_id.as_deref(),
      actor_label: self.actor_label.as_deref(),
      action: &self.action,
      project_id: self.project_id.as_deref(),
      environment_id: self.environment_id.as_deref(),
      resource_type: self.resource_type.as_deref(),
      resource_id: self.resource_id.as_deref(),
      ip_address: self.ip_address.as_deref(),
      metadata: &self.metadata,
      created_at: &self.created_at,
    }
  }
}

/// One audit record's values, as [`append`] stores them and the chain
/// hashes them. The chain columns (`seq`, `prev_hash`, `record_hash`) are
/// derived from the chain head, so they are not part of it.
#[derive(Clone, Copy, Debug)]
pub struct AuditEntry<'a> {
  pub id: &'a str,
  pub actor_type: &'a str,
  pub actor_id: Option<&'a str>,
  pub actor_label: Option<&'a str>,
  pub action: &'a str,
  pub project_id: Option<&'a str>,
  pub environment_id: Option<&'a str>,
  pub resource_type: Option<&'a str>,
  pub resource_id: Option<&'a str>,
  /// Absent for records written outside a request.
  pub ip_address: Option<&'a str>,
  /// Serialized JSON, hashed exactly as stored.
  pub metadata: &'a str,
  pub created_at: &'a str,
}

impl AuditEntry<'_> {
  /// The record hash at a chain position.
  ///
  /// This is the only definition of what the chain covers: appending and
  /// verifying both call it, so a new column cannot be hashed on one side
  /// and forgotten on the other. Missing optional values hash as an empty
  /// string. Changing the field list or order invalidates every existing
  /// record, so it needs a new [`DOMAIN`] version.
  fn hash(
    &self,
    seq: i64,
    prev_hash: &str,
  ) -> String {
    digest(&[
      &seq.to_string(),
      self.id,
      self.actor_type,
      self.actor_id.unwrap_or_default(),
      self.actor_label.unwrap_or_default(),
      self.action,
      self.project_id.unwrap_or_default(),
      self.environment_id.unwrap_or_default(),
      self.resource_type.unwrap_or_default(),
      self.resource_id.unwrap_or_default(),
      self.ip_address.unwrap_or_default(),
      self.metadata,
      self.created_at,
      prev_hash,
    ])
  }
}

const COLUMNS: &str = "id,actor_type,actor_id,actor_label,action,project_id,environment_id,resource_type,resource_id,ip_address,metadata,created_at,seq,prev_hash,record_hash";

fn digest(fields: &[&str]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(DOMAIN.as_bytes());
  for field in fields {
    hasher.update(field.len().to_string().as_bytes());
    hasher.update(b":");
    hasher.update(field.as_bytes());
    hasher.update(b"\n");
  }
  hex::encode(hasher.finalize())
}

/// The position and hash the next record chains from.
async fn head(connection: &mut SqliteConnection) -> Result<Option<(i64, String)>, sqlx::Error> {
  let newest = sqlx::query_as(
    "SELECT seq,record_hash FROM audit_events WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1",
  )
  .fetch_optional(&mut *connection)
  .await?;
  match newest {
    Some(head) => Ok(Some(head)),
    // Retention can remove every record; the chain then continues from the
    // pruning anchor instead of restarting at the genesis position.
    None => pruning_anchor(connection).await,
  }
}

/// The position and hash retention last pruned the chain through, if it
/// ever removed chained records.
async fn pruning_anchor(
  connection: &mut SqliteConnection
) -> Result<Option<(i64, String)>, sqlx::Error> {
  sqlx::query_as("SELECT pruned_seq,pruned_hash FROM audit_chain_anchor WHERE id='chain'")
    .fetch_optional(&mut *connection)
    .await
}

/// Append one record to the chain.
///
/// The caller's connection must already hold SQLite's write lock: either an
/// immediate transaction, or a transaction whose first statement was a
/// write. That makes reading the head and inserting atomic, so concurrent
/// appends cannot claim the same sequence number.
pub async fn append(
  connection: &mut SqliteConnection,
  entry: &AuditEntry<'_>,
) -> Result<(), sqlx::Error> {
  let (seq, prev_hash) = head(connection)
    .await?
    .map_or((1, GENESIS.to_owned()), |(seq, hash)| (seq + 1, hash));
  let record_hash = entry.hash(seq, &prev_hash);
  sqlx::query(&format!(
    "INSERT INTO audit_events({COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ))
  .bind(entry.id)
  .bind(entry.actor_type)
  .bind(entry.actor_id)
  .bind(entry.actor_label)
  .bind(entry.action)
  .bind(entry.project_id)
  .bind(entry.environment_id)
  .bind(entry.resource_type)
  .bind(entry.resource_id)
  .bind(entry.ip_address)
  .bind(entry.metadata)
  .bind(entry.created_at)
  .bind(seq)
  // The record that starts the chain stores no predecessor.
  .bind((seq > 1).then_some(prev_hash.as_str()))
  .bind(record_hash)
  .execute(&mut *connection)
  .await?;
  Ok(())
}

/// Matches records without a chain position that predate the chain's
/// genesis. Without a genesis row (a factory reset removed it), no record
/// qualifies, so every unsequenced record is suspect.
const LEGACY: &str =
  "seq IS NULL AND created_at < (SELECT started_at FROM audit_chain_genesis WHERE id='chain')";

/// The first inconsistency found while walking the chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainBreak {
  pub seq: i64,
  pub id: String,
  pub reason: String,
}

/// The outcome of walking the whole chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainReport {
  pub ok: bool,
  /// Records checked before the first break.
  pub records: u64,
  pub head_seq: Option<i64>,
  pub head_hash: Option<String>,
  /// Records written before the chain existed. They carry no hashes, so
  /// the chain cannot vouch for them, but they are not a failure.
  pub legacy: u64,
  /// Records with no chain position written after the chain existed. Any
  /// such record was inserted outside Dopbase and fails verification.
  pub unsequenced: u64,
  /// Sequence number retention removed up to, when records were pruned.
  /// The surviving records continue the chain after it.
  pub pruned_seq: Option<i64>,
  pub broken: Option<ChainBreak>,
  /// The outcome of checking an anchor saved outside the database, when
  /// one was given.
  pub anchor: Option<AnchorCheck>,
}

/// A chain position and hash saved outside the database, such as the head
/// reported by an earlier verification or an exported record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
  pub seq: i64,
  pub hash: String,
}

/// How the log compares with an [`Anchor`]. Serialized in lowercase, as the
/// verify API returns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum AnchorStatus {
  /// The record at that position still has that hash.
  Matched,
  /// The record at that position has a different hash: history up to it
  /// was rewritten.
  Mismatch,
  /// No record holds that position and retention did not remove it: that
  /// record and any after it were deleted.
  Missing,
  /// Retention removed that position; only the pruning archive can confirm
  /// it.
  Pruned,
}

impl AnchorStatus {
  fn is_failure(self) -> bool {
    matches!(self, Self::Mismatch | Self::Missing)
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnchorCheck {
  pub seq: i64,
  pub status: AnchorStatus,
}

/// Walk the chain in sequence order and recompute every hash.
///
/// The walk runs in one read transaction, so it checks a single snapshot:
/// appends or retention committing meanwhile cannot make it see a gap.
pub async fn verify(pool: &SqlitePool) -> Result<ChainReport, sqlx::Error> {
  verify_against(pool, None).await
}

/// Like [`verify`], and also compare the log with an anchor saved outside
/// the database. The chain alone cannot tell a full rewrite, or removal of
/// the newest records, from an honest log; an outside anchor can.
pub async fn verify_against(
  pool: &SqlitePool,
  anchor: Option<&Anchor>,
) -> Result<ChainReport, sqlx::Error> {
  let mut snapshot = pool.begin().await?;
  let mut report = verify_snapshot(&mut snapshot).await?;
  if let Some(anchor) = anchor {
    let status = check_anchor(&mut snapshot, anchor).await?;
    report.ok = report.ok && !status.is_failure();
    report.anchor = Some(AnchorCheck {
      seq: anchor.seq,
      status,
    });
  }
  snapshot.rollback().await?;
  Ok(report)
}

async fn check_anchor(
  connection: &mut SqliteConnection,
  anchor: &Anchor,
) -> Result<AnchorStatus, sqlx::Error> {
  let stored: Option<Option<String>> =
    sqlx::query_scalar("SELECT record_hash FROM audit_events WHERE seq=?")
      .bind(anchor.seq)
      .fetch_optional(&mut *connection)
      .await?;
  if let Some(hash) = stored {
    return Ok(if hash.as_deref() == Some(anchor.hash.as_str()) {
      AnchorStatus::Matched
    } else {
      AnchorStatus::Mismatch
    });
  }
  Ok(match pruning_anchor(connection).await? {
    Some((seq, hash)) if seq == anchor.seq => {
      if hash == anchor.hash {
        AnchorStatus::Matched
      } else {
        AnchorStatus::Mismatch
      }
    }
    Some((seq, _)) if anchor.seq < seq => AnchorStatus::Pruned,
    _ => AnchorStatus::Missing,
  })
}

/// Log the chain head so a copy of it lands outside the database, in
/// whatever collects the server's log. Comparing a logged head with a later
/// verification exposes a rewrite or a truncation of the log.
pub async fn log_checkpoint(pool: &SqlitePool) {
  let mut connection = match pool.acquire().await {
    Ok(connection) => connection,
    Err(error) => {
      tracing::warn!(%error, "audit checkpoint could not be read");
      return;
    }
  };
  match head(&mut connection).await {
    Ok(Some((seq, hash))) => {
      tracing::info!(seq, %hash, "audit checkpoint")
    }
    Ok(None) => tracing::info!("audit checkpoint: log is empty"),
    Err(error) => tracing::warn!(%error, "audit checkpoint could not be read"),
  }
}

async fn verify_snapshot(connection: &mut SqliteConnection) -> Result<ChainReport, sqlx::Error> {
  let counts = sqlx::query(&format!(
    "SELECT COUNT(*) AS total, COALESCE(SUM({LEGACY}),0) AS legacy FROM audit_events WHERE seq IS NULL"
  ))
  .fetch_one(&mut *connection)
  .await?;
  let count = |column: &str| u64::try_from(counts.get::<i64, _>(column)).unwrap_or_default();
  let legacy = count("legacy");
  let unsequenced = count("total").saturating_sub(legacy);
  let mut report = ChainReport {
    ok: true,
    records: 0,
    head_seq: None,
    head_hash: None,
    legacy,
    unsequenced,
    pruned_seq: None,
    broken: None,
    anchor: None,
  };
  // Records retention removed leave an anchor behind: the chain starts
  // there instead of at genesis, so pruning does not look like tampering.
  let anchor = pruning_anchor(connection).await?;
  report.pruned_seq = anchor.as_ref().map(|(seq, _)| *seq);
  let mut after: Option<i64> = None;
  let mut previous: Option<(i64, String)> = anchor.clone();
  'walk: loop {
    let page = sqlx::query_as::<_, Record>(&format!(
      "SELECT {COLUMNS} FROM audit_events WHERE seq IS NOT NULL AND (?1 IS NULL OR seq > ?1) ORDER BY seq ASC LIMIT {VERIFY_PAGE}"
    ))
    .bind(after)
    .fetch_all(&mut *connection)
    .await?;
    if page.is_empty() {
      break;
    }
    for record in page {
      let seq = record.seq.unwrap_or_default();
      let expected_prev = previous
        .as_ref()
        .map_or(GENESIS.to_owned(), |(_, hash)| hash.clone());
      let reason = if previous
        .as_ref()
        .is_some_and(|(previous_seq, _)| seq != *previous_seq + 1)
      {
        Some("sequence gap")
      } else if record.prev_hash.as_deref().unwrap_or(GENESIS) != expected_prev {
        Some("previous record hash does not match")
      } else if record.record_hash.as_deref()
        != Some(record.entry().hash(seq, &expected_prev).as_str())
      {
        Some("record hash does not match its contents")
      } else {
        None
      };
      if let Some(reason) = reason {
        report.broken = Some(ChainBreak {
          seq,
          id: record.id.clone(),
          reason: reason.into(),
        });
        report.ok = false;
        break 'walk;
      }
      report.records += 1;
      report.head_seq = Some(seq);
      report.head_hash = record.record_hash.clone();
      previous = Some((seq, record.record_hash.clone().unwrap_or_default()));
      after = Some(seq);
    }
  }
  if let (None, Some((pruned_seq, pruned_hash))) = (&report.broken, &anchor)
    && !pruning_is_evidenced(connection, *pruned_seq, pruned_hash).await?
  {
    report.broken = Some(ChainBreak {
      seq: *pruned_seq,
      id: "audit_chain_anchor".into(),
      reason: "pruning anchor has no matching audit.pruned record".into(),
    });
    report.ok = false;
  }
  report.ok = report.ok && report.unsequenced == 0;
  Ok(report)
}

/// Whether a chained `audit.pruned` record vouches for the pruning anchor.
///
/// The anchor row lives outside the chain, so on its own anyone could move
/// it forward to hide the oldest records. Every retention pass that prunes
/// chained records appends an `audit.pruned` record naming the position and
/// hash it pruned through, after the anchor, so the newest such record must
/// match the anchor exactly.
async fn pruning_is_evidenced(
  connection: &mut SqliteConnection,
  pruned_seq: i64,
  pruned_hash: &str,
) -> Result<bool, sqlx::Error> {
  let evidence = sqlx::query(
    "SELECT json_extract(metadata,'$.throughSeq') AS through_seq, json_extract(metadata,'$.throughHash') AS through_hash \
     FROM audit_events WHERE action='audit.pruned' AND seq > ? AND json_extract(metadata,'$.throughSeq') IS NOT NULL \
     ORDER BY seq DESC LIMIT 1",
  )
  .bind(pruned_seq)
  .fetch_optional(&mut *connection)
  .await?;
  Ok(evidence.is_some_and(|row| {
    row.get::<Option<i64>, _>("through_seq") == Some(pruned_seq)
      && row.get::<Option<String>, _>("through_hash").as_deref() == Some(pruned_hash)
  }))
}

/// How long the audit log is kept.
///
/// Records older than the window are archived to the data directory as JSON
/// lines before they are deleted, so the evidence outlives the deletion and
/// an operator can ship the archive elsewhere. Only the oldest contiguous
/// run of records is removed: the deletion leaves an anchor with the newest
/// removed record's position and hash, which is where verification picks
/// the chain back up.
#[derive(Clone, Debug)]
pub struct Retention {
  archive_dir: PathBuf,
  keep_days: u64,
}

impl Retention {
  pub fn new(
    archive_dir: PathBuf,
    keep_days: u64,
  ) -> Self {
    Self {
      archive_dir,
      keep_days,
    }
  }

  /// Archive and delete every record older than the retention window.
  ///
  /// The caller's connection must hold SQLite's write lock. The work runs in
  /// a savepoint, so a failure part-way never leaves a deletion without its
  /// anchor, and only the retention step is undone: the caller's own
  /// transaction can still commit. Returns how many records were removed.
  pub async fn apply(
    &self,
    connection: &mut SqliteConnection,
  ) -> anyhow::Result<u64> {
    let mut savepoint = connection.begin().await?;
    let pruned = self
      .apply_before(&mut savepoint, &cutoff_for(self.keep_days))
      .await?;
    savepoint.commit().await?;
    Ok(pruned)
  }

  /// Every run that removes something appends an `audit.pruned` record
  /// naming what it removed, so the pruning anchor is itself evidenced by
  /// the chain: an anchor that no such record vouches for fails
  /// verification.
  async fn apply_before(
    &self,
    connection: &mut SqliteConnection,
    cutoff: &str,
  ) -> anyhow::Result<u64> {
    let legacy = self.prune_legacy(connection, cutoff).await?;
    let chained = self.prune_chained(connection, cutoff).await?;
    if legacy.is_none() && chained.is_none() {
      return Ok(0);
    }
    let legacy_records = legacy.as_ref().map_or(0, |(records, _)| *records);
    let removed = legacy_records + chained.as_ref().map_or(0, |pruned| pruned.records);
    let metadata = json!({
      "legacyRecords": legacy_records,
      "legacyArchive": legacy.as_ref().map(|(_, archive)| archive.as_str()),
      "records": chained.as_ref().map_or(0, |pruned| pruned.records),
      "archive": chained.as_ref().map(|pruned| pruned.archive.as_str()),
      "fromSeq": chained.as_ref().map(|pruned| pruned.from_seq),
      "throughSeq": chained.as_ref().map(|pruned| pruned.through_seq),
      "throughHash": chained.as_ref().map(|pruned| pruned.through_hash.as_str()),
    });
    append(
      connection,
      &AuditEntry {
        id: &crate::services::token::public_id("aud_"),
        actor_type: "system",
        actor_id: None,
        actor_label: Some("retention"),
        action: "audit.pruned",
        project_id: None,
        environment_id: None,
        resource_type: Some("audit"),
        resource_id: None,
        ip_address: None,
        metadata: &metadata.to_string(),
        created_at: &chrono::Utc::now().to_rfc3339(),
      },
    )
    .await?;
    Ok(removed)
  }

  /// Legacy records sit outside the chain, so removing them needs no
  /// anchor. They are archived like chained ones before they go.
  async fn prune_legacy(
    &self,
    connection: &mut SqliteConnection,
    cutoff: &str,
  ) -> anyhow::Result<Option<(u64, String)>> {
    let expired = sqlx::query_as::<_, Record>(&format!(
      "SELECT {COLUMNS} FROM audit_events WHERE {LEGACY} AND created_at < ? ORDER BY created_at,id"
    ))
    .bind(cutoff)
    .fetch_all(&mut *connection)
    .await?;
    let (Some(first), Some(last)) = (expired.first(), expired.last()) else {
      return Ok(None);
    };
    // Named after the first and last record, so a retry rewrites the same
    // file and a later run never overwrites an earlier archive.
    let archive = format!("audit-legacy-{}-{}.jsonl", first.id, last.id);
    write_archive(&self.archive_dir, &archive, &expired).await?;
    sqlx::query(&format!(
      "DELETE FROM audit_events WHERE {LEGACY} AND created_at < ?"
    ))
    .bind(cutoff)
    .execute(&mut *connection)
    .await?;
    Ok(Some((expired.len() as u64, archive)))
  }

  async fn prune_chained(
    &self,
    connection: &mut SqliteConnection,
    cutoff: &str,
  ) -> anyhow::Result<Option<Pruned>> {
    let expired = sqlx::query_as::<_, Record>(&format!(
      "SELECT {COLUMNS} FROM audit_events WHERE seq IS NOT NULL AND created_at < ? ORDER BY seq"
    ))
    .bind(cutoff)
    .fetch_all(&mut *connection)
    .await?;
    // Only the oldest contiguous run of records can be removed: an expired
    // record that sits behind a retained one would leave a hole in the
    // chain that no anchor can describe, so it stays until everything
    // before it has expired too.
    let minimum = sqlx::query("SELECT MIN(seq) AS seq FROM audit_events WHERE seq IS NOT NULL")
      .fetch_one(&mut *connection)
      .await?
      .get::<Option<i64>, _>("seq");
    let mut prefix: Vec<Record> = Vec::new();
    for record in expired {
      let expected = prefix
        .last()
        .map_or(minimum, |last| last.seq.map(|seq| seq + 1));
      if record.seq != expected {
        break;
      }
      prefix.push(record);
    }
    let Some(first) = prefix.first() else {
      return Ok(None);
    };
    let latest = prefix.last().unwrap_or(first);
    let position = |record: &Record| record.seq.unwrap_or_default();
    let through_hash = latest.record_hash.clone().unwrap_or_default();
    // The archive is named after the sequence range it holds, so a retry
    // after a failed transaction rewrites the same file instead of leaving
    // two copies of one range for an offline verifier to double-count.
    let archive = format!("audit-{:06}-{:06}.jsonl", position(first), position(latest));
    write_archive(&self.archive_dir, &archive, &prefix).await?;
    sqlx::query("DELETE FROM audit_events WHERE seq IS NOT NULL AND seq <= ?")
      .bind(position(latest))
      .execute(&mut *connection)
      .await?;
    sqlx::query(
      "INSERT INTO audit_chain_anchor(id,pruned_seq,pruned_hash,pruned_at) VALUES('chain',?,?,?) \
       ON CONFLICT(id) DO UPDATE SET pruned_seq=excluded.pruned_seq,pruned_hash=excluded.pruned_hash,pruned_at=excluded.pruned_at",
    )
    .bind(position(latest))
    .bind(&through_hash)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&mut *connection)
    .await?;
    Ok(Some(Pruned {
      records: prefix.len() as u64,
      archive,
      from_seq: position(first),
      through_seq: position(latest),
      through_hash,
    }))
  }
}

/// Write records as JSON lines, owner-only, into the archive directory.
async fn write_archive(
  archive_dir: &Path,
  name: &str,
  records: &[Record],
) -> anyhow::Result<()> {
  let mut contents = Vec::new();
  for record in records {
    serde_json::to_writer(&mut contents, &record.archived())?;
    contents.push(b'\n');
  }
  let archive_dir = archive_dir.to_owned();
  let path = archive_dir.join(name);
  // Callers hold SQLite's write lock, so blocking file I/O stays off the
  // async workers that every other request needs.
  tokio::task::spawn_blocking(move || {
    fs::create_dir_all(&archive_dir)?;
    crate::utils::private_file::write(&path, &contents, true)
  })
  .await?
}

/// What [`archive_all`] saved before the audit log was replaced.
pub struct ArchivedLog {
  pub records: u64,
  /// File name inside the archive directory; `None` when the log was empty.
  pub archive: Option<String>,
  /// Position and hash the replaced chain ended at.
  pub head: Option<(i64, String)>,
}

/// Archive every audit record, legacy ones included, before the log is
/// replaced wholesale, as a backup restore does. Restoring would otherwise
/// erase everything written since the snapshot while the restored chain
/// still verifies. Runs on the caller's connection so the archive matches
/// what the caller then deletes.
pub async fn archive_all(
  connection: &mut SqliteConnection,
  archive_dir: &Path,
) -> anyhow::Result<ArchivedLog> {
  let records = sqlx::query_as::<_, Record>(&format!(
    "SELECT {COLUMNS} FROM audit_events ORDER BY seq IS NULL DESC,seq,created_at,id"
  ))
  .fetch_all(&mut *connection)
  .await?;
  let head = head(connection).await?;
  if records.is_empty() {
    return Ok(ArchivedLog {
      records: 0,
      archive: None,
      head,
    });
  }
  let archive = format!(
    "pre-restore-{}.jsonl",
    chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
  );
  write_archive(archive_dir, &archive, &records).await?;
  Ok(ArchivedLog {
    records: records.len() as u64,
    archive: Some(archive),
    head,
  })
}

/// The run of chained records one retention pass removed.
struct Pruned {
  records: u64,
  archive: String,
  from_seq: i64,
  through_seq: i64,
  through_hash: String,
}

fn cutoff_for(keep_days: u64) -> String {
  let days = i64::try_from(keep_days).unwrap_or(i64::MAX).min(365_000);
  (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339()
}

/// Apply a retention policy in a transaction this function owns, as startup
/// and [`spawn_retention`] do. Returns how many records were removed.
pub async fn apply_retention(
  pool: &SqlitePool,
  retention: &Retention,
) -> anyhow::Result<u64> {
  let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
  let pruned = retention.apply(&mut transaction).await?;
  transaction.commit().await?;
  Ok(pruned)
}

/// Apply a retention policy every `period`, starting one period from now,
/// until the returned task is aborted. Startup applies the policy itself,
/// so the first pass here is not due yet.
///
/// Running on a timer keeps one pass, one archive file, and one
/// `audit.pruned` record per period. Pruning on every audit write would
/// produce one of each per request once records start expiring. A failed
/// pass is logged and retried on the next tick; it never stops the server.
pub fn spawn_retention(
  pool: SqlitePool,
  retention: Retention,
  period: Duration,
) -> tokio::task::JoinHandle<()> {
  tokio::spawn(async move {
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
      ticker.tick().await;
      match apply_retention(&pool, &retention).await {
        Ok(0) => {}
        Ok(removed) => tracing::info!(removed, "audit retention removed expired records"),
        Err(error) => tracing::warn!(%error, "audit retention could not be applied"),
      }
    }
  })
}
