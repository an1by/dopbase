use super::{SecretCommand, args::HISTORY_LIMIT};
use crate::cli::{commands::environment, output, prompt};
use crate::{
  cli::{client, local_config},
  constants::api as api_paths,
};
use anyhow::{Context, Result, bail};
use reqwest::Method;
use serde_json::{Value, json};
use std::io::{self, IsTerminal};

pub(crate) async fn execute(
  command: SecretCommand,
  server: &local_config::ResolvedServer,
  json_output: bool,
) -> Result<i32> {
  let api = if matches!(&command, SecretCommand::Get { reveal: true, .. }) {
    client::recently_authenticated_client(server).await?
  } else if matches!(
    &command,
    SecretCommand::List { .. }
      | SecretCommand::Get { reveal: false, .. }
      | SecretCommand::History { .. }
  ) {
    client::metadata_client(server).await?
  } else {
    client::human_client(server).await?
  };
  match command {
    SecretCommand::List { environment } => {
      let env = environment::resolve_environment(&api, &environment).await?;
      let data = api
        .request(
          Method::GET,
          &api_paths::secrets::collection(environment::env_id(&env)?),
          None,
        )
        .await?;
      if json_output {
        output::print_json(&data)?;
      } else {
        let rows = output::array(&data)
          .iter()
          .map(|secret| {
            vec![
              output::string(secret, "key"),
              secret
                .get("version")
                .and_then(Value::as_i64)
                .unwrap_or_default()
                .to_string(),
              output::timestamp(secret, "updatedAt"),
            ]
          })
          .collect::<Vec<_>>();
        output::print_table(
          &["KEY", "VERSION", "UPDATED"],
          &rows,
          &format!("No secrets found in {environment}."),
          &format!("{} secret(s)", rows.len()),
        );
      }
    }
    SecretCommand::Set {
      environment,
      key,
      stdin,
    } => {
      let value = if stdin {
        prompt::read_secret_stdin(&key)?
      } else {
        if !io::stdin().is_terminal() {
          bail!("use --stdin when setting a secret non-interactively");
        }
        prompt::password("Secret value:", true, client::CliCancelled::SecretInput)?
      };
      let env = environment::resolve_environment(&api, &environment).await?;
      let data = api
        .request(
          Method::PUT,
          &api_paths::secrets::item(environment::env_id(&env)?, &key),
          Some(json!({"value":value})),
        )
        .await?;
      if json_output {
        output::print_json(&data)?;
      } else {
        output::print_success(&format!("Saved {key} in {environment}."));
        output::print_fields(&[(
          "Version:",
          data
            .get("version")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            .to_string(),
        )]);
      }
    }
    SecretCommand::Get {
      environment,
      key,
      reveal,
      version: Some(version),
    } => {
      let env = environment::resolve_environment(&api, &environment).await?;
      let env_id = environment::env_id(&env)?;
      if reveal {
        let data = api
          .request(
            Method::POST,
            &api_paths::secrets::version_reveal(env_id, &key, version),
            None,
          )
          .await?;
        if json_output {
          output::print_json(&data)?;
        } else {
          output::print_raw(&output::string(&data, "value"))?;
        }
      } else {
        let Some(item) = find_version(&api, env_id, &key, version).await? else {
          bail!("version {version} of {key} was not found in {environment}");
        };
        if json_output {
          output::print_json(&item)?;
        } else {
          output::print_fields(&[
            ("Key:", output::printable(&key)),
            ("Version:", version.to_string()),
            ("Change:", change_label(&item)),
            ("By:", actor_label(&item)),
            ("Saved:", output::timestamp(&item, "createdAt")),
            ("Status:", status_label(&item).into()),
          ]);
        }
      }
    }
    SecretCommand::Get {
      environment,
      key,
      reveal,
      version: None,
    } => {
      let env = environment::resolve_environment(&api, &environment).await?;
      let action = if reveal {
        api_paths::secrets::reveal(environment::env_id(&env)?, &key)
      } else {
        api_paths::secrets::item(environment::env_id(&env)?, &key)
      };
      let data = api
        .request(
          if reveal { Method::POST } else { Method::GET },
          &action,
          None,
        )
        .await?;
      if json_output {
        output::print_json(&data)?;
      } else if reveal {
        output::print_raw(&output::string(&data, "value"))?;
      } else {
        output::print_fields(&[
          ("Key:", output::string(&data, "key")),
          (
            "Version:",
            data
              .get("version")
              .and_then(Value::as_i64)
              .unwrap_or_default()
              .to_string(),
          ),
          ("Created:", output::timestamp(&data, "createdAt")),
          ("Updated:", output::timestamp(&data, "updatedAt")),
        ]);
      }
    }
    SecretCommand::History {
      environment,
      key,
      limit,
      before,
    } => {
      let env = environment::resolve_environment(&api, &environment).await?;
      let page = api
        .request(
          Method::GET,
          &versions_path(environment::env_id(&env)?, &key, limit, before),
          None,
        )
        .await?;
      let items = page
        .get("items")
        .and_then(Value::as_array)
        .context("unexpected secret history response")?;
      if json_output {
        output::print_json(&page)?;
      } else {
        let rows = items
          .iter()
          .map(|item| {
            vec![
              format!("v{}", version_of(item)),
              change_label(item),
              actor_label(item),
              output::timestamp(item, "createdAt"),
              status_label(item).into(),
            ]
          })
          .collect::<Vec<_>>();
        output::print_table(
          &["VERSION", "CHANGE", "BY", "SAVED", "STATUS"],
          &rows,
          &format!("No versions of {key} found."),
          &format!("{} version(s)", rows.len()),
        );
      }
      if let Some(next) = page.get("nextBefore").and_then(Value::as_i64) {
        let mut command = format!(
          "dopbase secret history {} {}",
          output::shell_quote(&environment),
          output::shell_quote(&key)
        );
        if limit != HISTORY_LIMIT {
          command.push_str(&format!(" --limit {limit}"));
        }
        command.push_str(&format!(" --before {next}"));
        output::print_info(&format!(
          "More versions exist. Next page: {}",
          output::printable(&command)
        ));
      }
    }
    SecretCommand::Rollback {
      environment,
      key,
      version,
      yes,
    } => {
      if yes && version.is_none() {
        bail!("--yes needs a VERSION. Run `dopbase secret history` to find one");
      }
      if version.is_none() && !io::stdin().is_terminal() {
        bail!(
          "pass VERSION when running non-interactively. Run `dopbase secret history` to find one"
        );
      }
      let env = environment::resolve_environment(&api, &environment).await?;
      let env_id = environment::env_id(&env)?;
      let page = api
        .request(Method::GET, &versions_path(env_id, &key, 200, None), None)
        .await?;
      let items = page
        .get("items")
        .and_then(Value::as_array)
        .context("unexpected secret history response")?;
      let current = items
        .iter()
        .find(|item| item.get("current").and_then(Value::as_bool) == Some(true))
        .context("unexpected secret history response: no current version")?
        .clone();
      let target = match version {
        Some(version) => match items.iter().find(|item| version_of(item) == version) {
          Some(item) => item.clone(),
          None => find_version(&api, env_id, &key, version)
            .await?
            .with_context(|| {
              format!("version {version} of {key} was not found in {environment}")
            })?,
        },
        None => {
          let choices: Vec<&Value> = items
            .iter()
            .filter(|item| is_true(item, "restorable") && !is_true(item, "current"))
            .collect();
          if choices.is_empty() {
            bail!("{key} has no earlier version to roll back to");
          }
          let labels = choices
            .iter()
            .map(|item| {
              format!(
                "v{}  {}  {}  {}",
                version_of(item),
                change_label(item),
                actor_label(item),
                output::timestamp(item, "createdAt")
              )
            })
            .collect();
          let index = prompt::select(
            &format!("Roll back {} to which version?", output::printable(&key)),
            labels,
            client::CliCancelled::Confirmation,
          )?;
          choices[index].clone()
        }
      };
      let target_version = version_of(&target);
      if is_true(&target, "current") {
        bail!("v{target_version} is already the current value of {key}");
      }
      if !is_true(&target, "restorable") {
        bail!(
          "v{target_version} of {key} is past the retention limit, so its value is no longer stored"
        );
      }
      let current_version = version_of(&current);
      if !json_output {
        output::print_text(&format!(
          "Roll back {} in {}",
          output::printable(&key),
          output::printable(&environment)
        ));
        output::print_fields(&[
          ("  Current:", describe_version(&current)),
          ("  Restore:", describe_version(&target)),
          (
            "  Result:",
            format!(
              "saved as v{} with the value from v{target_version}",
              current_version + 1
            ),
          ),
        ]);
      }
      prompt::confirm(
        &format!(
          "Roll back {} to v{target_version}?",
          output::printable(&key)
        ),
        yes,
      )?;
      let data = api
        .request(
          Method::POST,
          &api_paths::secrets::rollback(env_id, &key),
          Some(json!({"version": target_version, "expectedVersion": current_version})),
        )
        .await?;
      if json_output {
        output::print_json(&data)?;
      } else {
        output::print_success(&format!(
          "Rolled back {} to the value from v{target_version}. Current version: v{}.",
          output::printable(&key),
          version_of(&data)
        ));
        output::print_info(
          "Running `dopbase run` processes keep the old value until they restart.",
        );
      }
    }
    SecretCommand::Delete {
      environment,
      key,
      yes,
    } => {
      prompt::confirm(&format!("Delete secret {key} from {environment}?"), yes)?;
      let env = environment::resolve_environment(&api, &environment).await?;
      let data = api
        .request(
          Method::DELETE,
          &api_paths::secrets::item(environment::env_id(&env)?, &key),
          None,
        )
        .await?;
      if json_output {
        output::print_json(&data)?;
      } else {
        output::print_success(&format!("Deleted {key} from {environment}."));
      }
    }
  }
  Ok(0)
}

fn versions_path(
  env_id: &str,
  key: &str,
  limit: u32,
  before: Option<i64>,
) -> String {
  let limit = limit.to_string();
  let before = before
    .map(|version| version.to_string())
    .unwrap_or_default();
  api_paths::secrets::versions(env_id, key, &[("limit", &limit), ("before", &before)])
}

/// Fetches the metadata of one version, wherever it sits in the history.
async fn find_version(
  api: &client::ApiClient,
  env_id: &str,
  key: &str,
  version: i64,
) -> Result<Option<Value>> {
  let page = api
    .request(
      Method::GET,
      &versions_path(env_id, key, 1, Some(version + 1)),
      None,
    )
    .await?;
  Ok(
    page
      .get("items")
      .and_then(Value::as_array)
      .and_then(|items| items.first())
      .filter(|item| version_of(item) == version)
      .cloned(),
  )
}

fn version_of(item: &Value) -> i64 {
  item
    .get("version")
    .and_then(Value::as_i64)
    .unwrap_or_default()
}

fn is_true(
  item: &Value,
  field: &str,
) -> bool {
  item.get(field).and_then(Value::as_bool) == Some(true)
}

fn change_label(item: &Value) -> String {
  match item.get("changeType").and_then(Value::as_str) {
    Some("rolled_back") => match item.get("sourceVersion").and_then(Value::as_i64) {
      Some(source) => format!("rolled back from v{source}"),
      None => "rolled back".into(),
    },
    Some("legacy") => "before history".into(),
    Some(change) => output::printable(change),
    None => "-".into(),
  }
}

fn actor_label(item: &Value) -> String {
  match item.get("actorLabel").and_then(Value::as_str) {
    Some(label) => output::printable(label),
    None if item.get("actorType").and_then(Value::as_str) == Some("system") => "-".into(),
    None => output::string(item, "actorType"),
  }
}

fn status_label(item: &Value) -> &'static str {
  if is_true(item, "current") {
    "current"
  } else if is_true(item, "restorable") {
    "available"
  } else {
    "expired"
  }
}

fn describe_version(item: &Value) -> String {
  format!(
    "v{}  {}, {}, {}",
    version_of(item),
    change_label(item),
    actor_label(item),
    output::timestamp(item, "createdAt")
  )
}
