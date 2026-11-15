use crate::cli::{
  client::{self as api_client, ApiClient},
  local_config,
};
use crate::cli::{commands::client as command_client, output, prompt};
use crate::constants::api;
use anyhow::{Context, Result, bail};
use reqwest::Method;
use serde_json::Value;
use std::path::Path;

pub(crate) async fn execute(
  server: &local_config::ResolvedServer,
  args: RestoreArgs,
  json_output: bool,
) -> Result<i32> {
  let RestoreArgs {
    path,
    key: key_input,
    setup_token,
    yes,
  } = args;
  if !path.exists() {
    bail!("Backup file not found: {}", path.display());
  }
  let file_name = path
    .file_name()
    .and_then(|s| s.to_str())
    .unwrap_or("backup.dop");

  if !file_name.ends_with(".dop") {
    bail!("Invalid backup file: must have a .dop extension");
  }

  command_client::ensure_server_is_connected(server, "restore").await?;

  let master_key_bytes = if let Some(k) = key_input {
    let p = Path::new(&k);
    let raw = if p.exists() {
      std::fs::read(p)
        .with_context(|| format!("Failed to read master key file: {}", p.display()))?
    } else {
      k.into_bytes()
    };
    Some(crate::services::crypto::parse_master_key(&raw)?)
  } else {
    None
  };

  let bytes = std::fs::read(&path)
    .with_context(|| format!("Failed to read backup file: {}", path.display()))?;

  let anon_client = ApiClient::new(server, None)?;
  let status_res = anon_client
    .request(Method::GET, api::bootstrap::STATUS, None)
    .await?;

  let state = status_res
    .get("state")
    .and_then(Value::as_str)
    .unwrap_or("ready");

  if !yes {
    output::print_warning("Restoring will overwrite existing projects, environments, and secrets.");
    prompt::confirm(
      &format!("Proceed with restoring from \"{}\"?", path.display()),
      yes,
    )?;
  }

  if state == "setupRequired" {
    if !json_output {
      output::print_progress(
        1,
        2,
        &format!(
          "Connecting to the uninitialized server at {}...",
          server.url
        ),
      );
      output::print_progress(
        2,
        2,
        "Restoring the snapshot and initializing the instance...",
      );
    }
    let setup_token = setup_token
      .as_deref()
      .context("--setup-token is required when restoring an uninitialized server")?;
    let res = anon_client
      .upload_bootstrap_multipart(
        api::bootstrap::RESTORE,
        file_name,
        bytes,
        master_key_bytes,
        setup_token,
      )
      .await?;

    if json_output {
      output::print_json(&res)?;
    } else {
      output::print_success("Restore complete.");
      let mut fields = vec![
        ("Source:", path.display().to_string()),
        ("Server:", format!("{} (initialized)", server.url)),
        ("Sign in:", format!("{}/login", server.url)),
        ("Status:", "ready".into()),
      ];
      // One call, so the upgrade notes line up with the fields above.
      fields.extend(upgrade_fields(res.get("upgrade")));
      output::print_fields(&fields);
    }
  } else {
    if !json_output {
      output::print_progress(1, 3, "Authenticating the administrator session...");
    }
    let auth_client = api_client::recently_authenticated_client(server).await?;

    if !json_output {
      output::print_progress(2, 3, "Uploading the backup snapshot...");
    }
    let upload_res = auth_client
      .upload_backup_multipart(
        api::backups::UPLOAD,
        file_name,
        bytes,
        master_key_bytes.clone(),
      )
      .await?;
    let key = upload_res
      .get("key")
      .and_then(Value::as_str)
      .context("Uploaded backup missing key")?;

    if !json_output {
      output::print_progress(3, 3, "Restoring database tables and running migrations...");
    }
    let restore_url = api::backups::restore(key);
    let restore_body = master_key_bytes
      .as_ref()
      .map(|k| serde_json::json!({ "master_key": hex::encode(k) }));
    let restore_res = auth_client
      .request(Method::POST, &restore_url, restore_body)
      .await?;

    if json_output {
      output::print_json(&restore_res)?;
    } else {
      output::print_success("Restore complete.");
      let mut fields = vec![
        ("Source:", path.display().to_string()),
        ("Key:", key.to_owned()),
        ("Server:", server.url.clone()),
        ("Status:", "ready".into()),
      ];
      // A 0.1.x backup is upgraded when it is uploaded.
      fields.extend(upgrade_fields(
        upload_res
          .get("upgrade")
          .or_else(|| restore_res.get("upgrade")),
      ));
      output::print_fields(&fields);
    }
  }

  Ok(0)
}
use super::RestoreArgs;

/// What restoring a 0.1.x backup changed on the way in, as fields for the
/// restore summary. Prints a one-line note when there was an upgrade.
fn upgrade_fields(report: Option<&Value>) -> Vec<(&'static str, String)> {
  let Some(report) = report.filter(|report| report.is_object()) else {
    return Vec::new();
  };
  let notes = |key: &str| {
    report
      .get(key)
      .and_then(Value::as_array)
      .map(|notes| {
        notes
          .iter()
          .map(|note| {
            format!(
              "{} {} ({})",
              note.get("rows").and_then(Value::as_i64).unwrap_or_default(),
              note
                .get("table")
                .and_then(Value::as_str)
                .unwrap_or_default(),
              note
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            )
          })
          .collect::<Vec<_>>()
      })
      .unwrap_or_default()
  };
  output::print_info("This backup was made by Dopbase 0.1.x and was upgraded to 0.2.0.");
  let mut fields = Vec::new();
  for (label, line) in notes("dropped")
    .into_iter()
    .map(|line| ("Left out:", line))
    .chain(notes("changed").into_iter().map(|line| ("Changed:", line)))
  {
    fields.push((label, line));
  }
  let archived = report
    .get("archivedAuditRecords")
    .and_then(Value::as_u64)
    .unwrap_or_default();
  if archived > 0 {
    fields.push((
      "Audit archive:",
      format!(
        "{archived} record(s) from before the hash chain, saved to {}",
        report
          .get("auditArchive")
          .and_then(Value::as_str)
          .unwrap_or_default()
      ),
    ));
  }
  fields.push(("Next:", "Everyone signs in again.".into()));
  fields
}
