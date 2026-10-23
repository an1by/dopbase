use std::{io::Write, path::Path};

use super::{AuditCommand, AuditFilters};
use crate::cli::commands::environment;
use crate::cli::{
  client::{self, ApiClient},
  local_config, output,
};
use anyhow::{Context, Result, bail};
use reqwest::Method;
use serde_json::{Value, json};

use crate::constants::api as api_paths;

/// Page size used while streaming; the audit API caps `limit` at 200.
const PAGE_SIZE: u64 = 200;

pub(crate) async fn execute(
  command: AuditCommand,
  server: &local_config::ResolvedServer,
  json_output: bool,
) -> Result<i32> {
  let api = client::human_client(server).await?;
  match command {
    AuditCommand::Verify { anchor } => {
      let path = api_paths::audit::verify(anchor.as_ref().map(|(seq, hash)| (*seq, hash.as_str())));
      let report = api.request(Method::GET, &path, None).await?;
      let ok = report.get("ok").and_then(Value::as_bool).unwrap_or(false);
      if json_output {
        output::print_json(&report)?;
      } else {
        print_report(&report);
      }
      Ok(if ok { 0 } else { 2 })
    }
    AuditCommand::Export {
      output,
      force,
      filters,
      limit,
    } => {
      let exported = export(&api, &filters, output.as_deref(), force, limit).await?;
      if let Some(path) = output {
        report_export(exported, &path, json_output)?;
      }
      Ok(0)
    }
  }
}

/// Audit filters with project and environment references resolved to the
/// IDs the audit list API matches on.
struct ResolvedFilters<'a> {
  action: Option<&'a str>,
  project_id: Option<String>,
  environment_id: Option<String>,
  actor: Option<&'a str>,
}

async fn resolve<'a>(
  api: &ApiClient,
  filters: &'a AuditFilters,
) -> Result<ResolvedFilters<'a>> {
  let project_id = match &filters.project {
    Some(reference) => Some(resolve_project(api, reference).await?),
    None => None,
  };
  let environment_id = match &filters.environment {
    Some(reference) => {
      let resolved = environment::resolve_environment(api, reference).await?;
      Some(environment::env_id(&resolved)?.to_owned())
    }
    None => None,
  };
  Ok(ResolvedFilters {
    action: filters.action.as_deref(),
    project_id,
    environment_id,
    actor: filters.actor.as_deref(),
  })
}

/// Builds the audit list path for one page. Values are URL-encoded by
/// `api_paths::audit::collection`, and the cursor is passed unchanged.
fn page_path(
  filters: &ResolvedFilters,
  limit: &str,
  cursor: Option<&str>,
) -> String {
  let mut params: Vec<(&str, &str)> = vec![("limit", limit)];
  for (name, value) in [
    ("action", filters.action),
    ("projectId", filters.project_id.as_deref()),
    ("environmentId", filters.environment_id.as_deref()),
    ("actor", filters.actor),
    ("cursor", cursor),
  ] {
    if let Some(value) = value {
      params.push((name, value));
    }
  }
  api_paths::audit::collection(&params)
}

fn page_items(page: &Value) -> Result<&[Value]> {
  page
    .get("items")
    .and_then(Value::as_array)
    .map(Vec::as_slice)
    .context("the server returned an unexpected audit list response")
}

fn next_cursor(page: &Value) -> Option<&str> {
  page
    .get("nextCursor")
    .and_then(Value::as_str)
    .filter(|cursor| !cursor.is_empty())
}

/// Streams matching audit records as JSON lines, one object per line, in
/// the order returned by the audit list API (newest first).
async fn export(
  api: &ApiClient,
  filters: &AuditFilters,
  output: Option<&Path>,
  force: bool,
  limit: Option<u64>,
) -> Result<u64> {
  if let Some(0) = limit {
    bail!("audit export requires --limit greater than zero");
  }
  let filters = resolve(api, filters).await?;
  let page_size = PAGE_SIZE.to_string();
  let mut file = Vec::new();
  let mut cursor: Option<String> = None;
  let mut exported = 0u64;
  'stream: loop {
    let path = page_path(&filters, &page_size, cursor.as_deref());
    let page = api.request(Method::GET, &path, None).await?;
    for item in page_items(&page)? {
      let mut line = serde_json::to_vec(item)?;
      line.push(b'\n');
      match output {
        Some(_) => file.extend_from_slice(&line),
        None => std::io::stdout()
          .write_all(&line)
          .context("failed to write audit export")?,
      }
      exported += 1;
      if limit.is_some_and(|limit| exported >= limit) {
        break 'stream;
      }
    }
    match next_cursor(&page) {
      Some(next) => cursor = Some(next.to_owned()),
      None => break,
    }
  }
  if let Some(path) = output {
    output::write_private(path, &file, force)?;
  }
  Ok(exported)
}

fn report_export(
  exported: u64,
  path: &Path,
  json_output: bool,
) -> Result<()> {
  if json_output {
    output::print_json(&json!({"exported": exported, "path": path.display().to_string()}))
  } else {
    output::print_success(&format!(
      "Exported {exported} audit record(s) to {}.",
      path.display()
    ));
    Ok(())
  }
}

/// Resolves a project name or ID to its ID. The API only resolves
/// environments by reference, so projects are matched against the list.
async fn resolve_project(
  api: &ApiClient,
  reference: &str,
) -> Result<String> {
  let projects = api
    .request(Method::GET, api_paths::projects::COLLECTION, None)
    .await?;
  output::array(&projects)
    .iter()
    .find(|project| {
      let id = project
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default();
      let name = project
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
      id == reference || name.eq_ignore_ascii_case(reference)
    })
    .and_then(|project| project.get("id").and_then(Value::as_str))
    .map(str::to_owned)
    .ok_or_else(|| anyhow::anyhow!("Project not found: {reference}"))
}

fn print_report(report: &Value) {
  let records = output::number(report, "records");
  let unsequenced = output::number(report, "unsequenced");
  let broken = report.get("broken").filter(|value| value.is_object());
  let mut fields = match broken {
    Some(chain_break) => vec![
      (
        "Chain:",
        format!(
          "BROKEN at sequence {} ({})",
          chain_break
            .get("seq")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
          output::string(chain_break, "id"),
        ),
      ),
      ("Reason:", output::string(chain_break, "reason")),
      ("Records verified:", records.to_string()),
    ],
    None => vec![
      ("Chain:", "intact".to_owned()),
      ("Records verified:", records.to_string()),
      (
        "Head sequence:",
        report
          .get("headSeq")
          .and_then(Value::as_i64)
          .map_or_else(|| "none".to_owned(), |seq| seq.to_string()),
      ),
      // Printed in full: SEQ:HASH is what `--anchor` takes later.
      (
        "Head hash:",
        report
          .get("headHash")
          .and_then(Value::as_str)
          .unwrap_or("none")
          .to_owned(),
      ),
    ],
  };
  if unsequenced > 0 {
    fields.push(("Unsequenced records:", unsequenced.to_string()));
  }
  if let Some(anchor) = report.get("anchor").filter(|value| value.is_object()) {
    let seq = anchor
      .get("seq")
      .and_then(Value::as_i64)
      .unwrap_or_default();
    let status = match anchor.get("status").and_then(Value::as_str) {
      Some("matched") => "matched".to_owned(),
      Some("mismatch") => "MISMATCH: the log was rewritten up to this record".to_owned(),
      Some("missing") => "MISSING: this record and any after it were deleted".to_owned(),
      Some("pruned") => "removed by retention; check it against the archive".to_owned(),
      other => other.unwrap_or("unknown").to_owned(),
    };
    fields.push(("Anchor:", format!("sequence {seq} {status}")));
  }
  let legacy = output::number(report, "legacy");
  if legacy > 0 {
    fields.push(("Legacy records (not chained):", legacy.to_string()));
  }
  if let Some(pruned) = report.get("prunedSeq").and_then(Value::as_i64) {
    fields.push(("Pruned through:", format!("sequence {pruned}")));
  }
  output::print_fields(&fields);
}
