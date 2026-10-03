use crate::cli::args::{Cli, Command};
use anyhow::{Context, Result, bail};
use std::{
  io::IsTerminal,
  process::{Command as ProcessCommand, Stdio},
};

pub fn execute_in_container(container: &str, cli: Cli) -> Result<i32> {
  let mut arguments = vec!["exec".to_string()];
  if std::io::stdin().is_terminal() {
    arguments.push("-it".to_string());
  }
  arguments.push(container.to_string());
  arguments.push("dopbase".to_string());
  if let Some(data_dir) = &cli.data_dir {
    arguments.push("--data-dir".to_string());
    arguments.push(data_dir.display().to_string());
  }
  if cli.json {
    arguments.push("--json".to_string());
  }
  if let Some(server) = &cli.server {
    arguments.push("--server".to_string());
    arguments.push(server.clone());
  }
  push_command(&mut arguments, cli.command)?;
  let status = ProcessCommand::new("docker")
    .args(&arguments)
    .stdin(Stdio::inherit())
    .stdout(Stdio::inherit())
    .stderr(Stdio::inherit())
    .status()
    .with_context(|| format!("failed to run `docker {}`", arguments.join(" ")))?;
  Ok(status.code().unwrap_or(1))
}

fn push_command(arguments: &mut Vec<String>, command: Command) -> Result<()> {
  match command {
    Command::Admin { command } => {
      arguments.push("admin".to_string());
      match command {
        crate::cli::args::AdminCommand::ResetPassword {
          email,
          config,
          master_key_file,
        } => {
          arguments.push("reset-password".to_string());
          arguments.push(email);
          if let Some(path) = config {
            arguments.push("--config".to_string());
            arguments.push(path.display().to_string());
          }
          if let Some(path) = master_key_file {
            arguments.push("--master-key-file".to_string());
            arguments.push(path.display().to_string());
          }
        }
        crate::cli::args::AdminCommand::FactoryReset { config, no_backup } => {
          arguments.push("factory-reset".to_string());
          if let Some(path) = config {
            arguments.push("--config".to_string());
            arguments.push(path.display().to_string());
          }
          if no_backup {
            arguments.push("--no-backup".to_string());
          }
        }
      }
    }
    Command::Server { command } => {
      arguments.push("server".to_string());
      push_server_command(arguments, command)?;
    }
    _ => bail!("`--container` only supports local `admin` and `server` commands"),
  }
  Ok(())
}

fn push_server_command(
  arguments: &mut Vec<String>,
  command: crate::cli::args::ServerCommand,
) -> Result<()> {
  use crate::cli::args::ServerCommand;
  match command {
    ServerCommand::Start(args) => {
      arguments.push("start".to_string());
      push_launch(arguments, &args.launch)?;
    }
    ServerCommand::Up(args) => {
      arguments.push("up".to_string());
      push_launch(arguments, &args)?;
    }
    ServerCommand::Down { timeout } => {
      arguments.push("down".to_string());
      arguments.push("--timeout".to_string());
      arguments.push(timeout.to_string());
    }
    ServerCommand::Status => arguments.push("status".to_string()),
    ServerCommand::Logs { lines, clean, watch } => {
      arguments.push("logs".to_string());
      arguments.push("--lines".to_string());
      arguments.push(lines.to_string());
      if clean {
        arguments.push("--clean".to_string());
      }
      if watch {
        arguments.push("--watch".to_string());
      }
    }
  }
  Ok(())
}

fn push_launch(
  arguments: &mut Vec<String>,
  args: &crate::cli::args::ServerLaunchArgs,
) -> Result<()> {
  if let Some(path) = &args.config {
    arguments.push("--config".to_string());
    arguments.push(path.display().to_string());
  }
  if let Some(path) = &args.master_key_file {
    arguments.push("--master-key-file".to_string());
    arguments.push(path.display().to_string());
  }
  if let Some(host) = &args.host {
    arguments.push("--host".to_string());
    arguments.push(host.clone());
  }
  if let Some(port) = args.port {
    arguments.push("--port".to_string());
    arguments.push(port.to_string());
  }
  if let Some(url) = &args.public_url {
    arguments.push("--public-url".to_string());
    arguments.push(url.clone());
  }
  if let Some(seconds) = args.shutdown_grace_seconds {
    arguments.push("--shutdown-grace-seconds".to_string());
    arguments.push(seconds.to_string());
  }
  match args.docs() {
    Some(true) => arguments.push("--docs".to_string()),
    Some(false) => arguments.push("--no-docs".to_string()),
    None => {}
  }
  Ok(())
}
