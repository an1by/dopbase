use std::path::PathBuf;

use clap::{Args, Subcommand};

#[derive(Subcommand, Debug)]
pub enum AuditCommand {
  /// Recompute the audit log's hash chain and report the first inconsistency.
  ///
  /// Exits with code 0 when the chain is intact and 2 when it is broken.
  #[command(after_help = VERIFY_HELP)]
  Verify {
    /// Also check the log against a head saved earlier, as SEQ:HASH.
    #[arg(long, value_name = "SEQ:HASH", value_parser = parse_anchor)]
    anchor: Option<(i64, String)>,
  },

  /// Stream audit records as JSON lines to standard output or a file.
  #[command(after_help = EXPORT_HELP)]
  Export {
    /// Write the export to a file instead of standard output.
    #[arg(long, value_name = "FILE")]
    output: Option<PathBuf>,

    /// Overwrite the output file if it already exists.
    #[arg(long)]
    force: bool,

    #[command(flatten)]
    filters: AuditFilters,

    /// Stop after this many records.
    #[arg(long, value_name = "N")]
    limit: Option<u64>,
  },
}

/// Filters for the audit list API. Names are resolved
/// to IDs before the audit request is sent.
#[derive(Args, Debug, Default)]
pub struct AuditFilters {
  /// Only records with this action, for example secret.updated.
  #[arg(long, value_name = "ACTION")]
  pub action: Option<String>,

  /// Only records for this project (name or ID).
  #[arg(long, value_name = "PROJECT_REF")]
  pub project: Option<String>,

  /// Only records for this environment (PROJECT/NAME or environment ID).
  #[arg(long, value_name = "ENVIRONMENT_REF")]
  pub environment: Option<String>,

  /// Only records for this actor (email or actor ID).
  #[arg(long, value_name = "ACTOR")]
  pub actor: Option<String>,
}

/// Parses an anchor such as `42:9f86d0…`: a positive sequence number and
/// the 64-character hex hash an earlier verification reported for it.
fn parse_anchor(value: &str) -> Result<(i64, String), String> {
  let (seq, hash) = value
    .split_once(':')
    .ok_or("expected SEQ:HASH, for example 42:9f86d081884c7d65…")?;
  let seq = seq
    .parse::<i64>()
    .ok()
    .filter(|seq| *seq > 0)
    .ok_or("the sequence number must be a positive integer")?;
  if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return Err("the hash must be the 64-character hex value verify reported".into());
  }
  Ok((seq, hash.to_ascii_lowercase()))
}

pub(crate) const HELP: &str = "\
Examples:
  dopbase audit verify
  dopbase audit export --output audit-2026-10-17.jsonl
  dopbase --json audit verify

The audit log is a hash chain: every record stores the hash of the record
before it, so a record that was modified, removed, or inserted after the
fact stands out. Administrators can also review events in the UI.
";
const VERIFY_HELP: &str = "\
Examples:
  dopbase audit verify
  dopbase --json audit verify
  dopbase audit verify --anchor 42:<HEAD_HASH>

Requires an administrator account. Verification walks the records in
sequence order and stops at the first break, reporting how many records
were checked before it. No secret values are read or printed.

The chain alone cannot tell a fully rewritten log, or one whose newest
records were deleted, from an honest one. Save the head sequence and hash
somewhere outside this server, then pass them to --anchor later: the check
fails if that record changed or no longer exists.
";
const EXPORT_HELP: &str = "\
Examples:
  dopbase audit export --output audit.jsonl
  dopbase audit export --action secret.updated --limit 500
  dopbase audit export --project production | jq 'select(.resourceType==\"secret\")'

Requires an administrator account. Each line is one JSON object exactly as
the audit list API returns it, including the chain fields seq, prevHash and
recordHash, so an exported copy can be checked and anchored outside Dopbase.
The whole record set is exported unless a filter or --limit applies, and no
secret values are read or printed. With --output the file is written
atomically with owner-only permissions, and --json reports the count as an
object instead of printing a summary line.
";
