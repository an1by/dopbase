use super::ProjectCommand;
use crate::cli::{client::ApiClient, output, prompt};
use crate::{
  cli::{client, local_config},
  constants::api as api_paths,
  utils::project_reference,
};
use anyhow::{Context, Result, bail};
use reqwest::Method;
use serde_json::{Value, json};

pub(crate) async fn execute(
  command: ProjectCommand,
  server: &local_config::ResolvedServer,
  json_output: bool,
) -> Result<i32> {
  let api = client::human_client(server).await?;
  match command {
    ProjectCommand::Create { name } => {
      let target = project_reference::parse_create_target(&name)
        .map_err(|error| anyhow::anyhow!(error))?;
      let data = api
        .request(
          Method::POST,
          api_paths::projects::COLLECTION,
          Some(json!({"name": target.name})),
        )
        .await?;
      if let (Some(workspace_name), Some(relative_path)) =
        (&target.workspace, &target.relative_path)
      {
        let workspace_id = resolve_workspace_id(&api, workspace_name).await?;
        let project_id = data
          .get("id")
          .and_then(Value::as_str)
          .context("project response did not contain an ID")?;
        api
          .request(
            Method::PATCH,
            &api_paths::projects::location(project_id),
            Some(json!({
              "workspaceId": workspace_id,
              "relativePath": relative_path,
            })),
          )
          .await?;
      }
      if json_output {
        output::print_json(&data)?;
      } else {
        output::print_success(&format!(
          "Created project {} ({}).",
          output::string(&data, "name"),
          output::string(&data, "id")
        ));
      }
    }
    ProjectCommand::Current => {
      let location = crate::cli::project_resolve::resolve_project_from_cwd(&api).await?;
      if json_output {
        output::print_json(&serde_json::json!({
          "project": location.as_ref().map(|item| &item.name),
          "workspaceRoot": location.as_ref().map(|item| &item.workspace_root),
          "relativePath": location.as_ref().map(|item| &item.relative_path),
        }))?;
      } else if let Some(location) = location {
        output::print_fields(&[
          ("Project:", location.name),
          ("Workspace root:", location.workspace_root),
          ("Directory:", location.relative_path),
        ]);
      } else {
        output::print_text(
          "No project is mapped to the current directory. Assign one in the Admin UI.",
        );
      }
    }
    ProjectCommand::List => {
      let data = api
        .request(Method::GET, api_paths::projects::COLLECTION, None)
        .await?;
      if json_output {
        output::print_json(&data)?;
      } else {
        let rows = output::array(&data)
          .iter()
          .map(|project| {
            vec![
              output::string(project, "name"),
              output::string(project, "id"),
              output::timestamp(project, "updatedAt"),
            ]
          })
          .collect::<Vec<_>>();
        output::print_table(
          &["NAME", "ID", "UPDATED"],
          &rows,
          "No projects found. Create one with: dopbase project create <name>",
          &format!("{} project(s)", rows.len()),
        );
      }
    }
    ProjectCommand::Show { project } => {
      let project = api_project_ref(&project)?;
      let data = api
        .request(Method::GET, &api_paths::projects::item(&project), None)
        .await?;
      if json_output {
        output::print_json(&data)?;
      } else {
        output::print_fields(&[
          ("Name:", output::string(&data, "name")),
          ("ID:", output::string(&data, "id")),
          ("Created:", output::timestamp(&data, "createdAt")),
          ("Updated:", output::timestamp(&data, "updatedAt")),
        ]);
      }
    }
    ProjectCommand::Rename { project, new_name } => {
      let project = api_project_ref(&project)?;
      let data = api
        .request(
          Method::PATCH,
          &api_paths::projects::item(&project),
          Some(json!({"name":new_name})),
        )
        .await?;
      if json_output {
        output::print_json(&data)?;
      } else {
        output::print_success(&format!(
          "Renamed project to {} ({}).",
          output::string(&data, "name"),
          output::string(&data, "id")
        ));
      }
    }
    ProjectCommand::Delete { project, yes } => {
      let project = api_project_ref(&project)?;
      let detail = api
        .request(Method::GET, &api_paths::projects::item(&project), None)
        .await?;
      let name = detail
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&project);
      let environments = api
        .request(
          Method::GET,
          &api_paths::environments::list(Some(&project)),
          None,
        )
        .await?;
      let count = environments.as_array().map_or(0, Vec::len);
      prompt::confirm(
        &format!("Delete project {name} and its {count} environment(s)?"),
        yes,
      )?;
      let data = api
        .request(Method::DELETE, &api_paths::projects::item(&project), None)
        .await?;
      if json_output {
        output::print_json(&data)?;
      } else {
        output::print_success(&format!("Deleted project {name}."));
        let affected = data.get("affected").unwrap_or(&Value::Null);
        output::print_fields(&[
          (
            "Projects:",
            output::number(affected, "projects").to_string(),
          ),
          (
            "Environments:",
            output::number(affected, "environments").to_string(),
          ),
          ("Secrets:", output::number(affected, "secrets").to_string()),
          ("Tokens:", output::number(affected, "tokens").to_string()),
        ]);
      }
    }
  }
  Ok(0)
}

fn api_project_ref(reference: &str) -> Result<String> {
  project_reference::to_api_reference(reference).map_err(|error| anyhow::anyhow!(error))
}

async fn resolve_workspace_id(
  api: &ApiClient,
  reference: &str,
) -> Result<String> {
  let workspaces = api
    .request(Method::GET, api_paths::workspaces::COLLECTION, None)
    .await?;
  let reference = reference.trim();
  let matches = output::array(&workspaces)
    .iter()
    .filter(|workspace| {
      workspace.get("id").and_then(Value::as_str) == Some(reference)
        || workspace.get("name").and_then(Value::as_str) == Some(reference)
    })
    .collect::<Vec<_>>();
  match matches.len() {
    0 => bail!("workspace not found: {reference}"),
    1 => Ok(
      matches[0]
        .get("id")
        .and_then(Value::as_str)
        .context("workspace response did not contain an ID")?
        .to_owned(),
    ),
    _ => bail!("multiple workspaces match {reference}; use a workspace ID"),
  }
}
