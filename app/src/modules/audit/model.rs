use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, ToSchema};
#[derive(Clone, Debug, Serialize, sqlx::FromRow, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
  pub id: String,
  pub actor_type: String,
  pub actor_id: Option<String>,
  pub actor_label: Option<String>,
  pub action: String,
  pub project_id: Option<String>,
  pub environment_id: Option<String>,
  pub resource_type: Option<String>,
  pub resource_id: Option<String>,
  /// The client address, resolved through any trusted proxies. Absent for
  /// records written outside a request and for records from before it was
  /// captured.
  pub ip_address: Option<String>,
  #[sqlx(json)]
  pub metadata: Value,
  pub created_at: String,
  /// Position in the audit hash chain, and the hashes of the record before
  /// this one and of this record's own contents. Absent only for records
  /// that predate the chain, which are never sealed.
  pub seq: Option<i64>,
  pub prev_hash: Option<String>,
  pub record_hash: Option<String>,
}
#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in=Query)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
  pub cursor: Option<String>,
  pub limit: Option<u32>,
  pub action: Option<String>,
  pub project_id: Option<String>,
  pub environment_id: Option<String>,
  pub actor: Option<String>,
}
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
  pub items: Vec<AuditEvent>,
  pub next_cursor: Option<String>,
}
/// The first inconsistency found while walking the audit hash chain.
#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChainVerifyBreak {
  pub seq: i64,
  pub id: String,
  pub reason: String,
}
/// The outcome of recomputing every audit record's hash in sequence order.
#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChainVerifyReport {
  /// True when every record matched its stored hashes and no record sits
  /// outside the chain.
  pub ok: bool,
  /// Records checked before the first break.
  pub records: u64,
  pub head_seq: Option<i64>,
  pub head_hash: Option<String>,
  /// Records written before the chain existed. They carry no hashes, so the
  /// chain cannot vouch for them, but they do not fail verification.
  pub legacy: u64,
  /// Records with no chain position written after the chain existed. Any
  /// such record was inserted outside Dopbase; it should stay at zero.
  pub unsequenced: u64,
  /// Sequence number retention removed up to, when records were pruned. The
  /// surviving records continue the chain after it.
  pub pruned_seq: Option<i64>,
  pub broken: Option<ChainVerifyBreak>,
  /// The outcome of comparing the log with `anchorSeq`/`anchorHash`, when
  /// they were given.
  pub anchor: Option<ChainVerifyAnchor>,
}

/// How the log compares with an anchor saved outside the database.
#[derive(Clone, Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChainVerifyAnchor {
  pub seq: i64,
  /// `matched`, `mismatch` (history was rewritten), `missing` (the newest
  /// records were deleted), or `pruned` (retention removed that position).
  pub status: String,
}

/// An anchor saved outside the database: a chain position and the hash the
/// record at that position had, such as an earlier `headSeq`/`headHash`.
#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in=Query)]
#[serde(rename_all = "camelCase")]
pub struct ChainVerifyQuery {
  pub anchor_seq: Option<i64>,
  pub anchor_hash: Option<String>,
}

impl From<crate::services::audit_chain::ChainReport> for ChainVerifyReport {
  fn from(report: crate::services::audit_chain::ChainReport) -> Self {
    Self {
      ok: report.ok,
      records: report.records,
      head_seq: report.head_seq,
      head_hash: report.head_hash,
      legacy: report.legacy,
      unsequenced: report.unsequenced,
      pruned_seq: report.pruned_seq,
      broken: report.broken.map(|chain_break| ChainVerifyBreak {
        seq: chain_break.seq,
        id: chain_break.id,
        reason: chain_break.reason,
      }),
      anchor: report.anchor.map(|check| ChainVerifyAnchor {
        seq: check.seq,
        status: check.status.as_str().into(),
      }),
    }
  }
}
