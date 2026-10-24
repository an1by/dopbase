use clap::Subcommand;

use crate::constants::help::ENVIRONMENT_ARG_HELP;

#[derive(Subcommand, Debug)]
pub enum SecretCommand {
  /// List secret keys in an environment (values are never shown).
  #[command(after_help = LIST_HELP)]
  List {
    #[arg(value_name = "ENVIRONMENT_REF", help = ENVIRONMENT_ARG_HELP)]
    environment: String,
  },
  /// Set a secret through a masked prompt or read it from standard input.
  #[command(after_help = SET_HELP)]
  Set {
    #[arg(value_name = "ENVIRONMENT_REF", help = ENVIRONMENT_ARG_HELP)]
    environment: String,
    /// Secret key name.
    key: String,
    /// Read until EOF. In a terminal, finish with Ctrl+D (Ctrl+Z then Enter on Windows).
    #[arg(long)]
    stdin: bool,
  },
  /// Show secret metadata, or print its value with --reveal.
  #[command(after_help = GET_HELP)]
  Get {
    #[arg(value_name = "ENVIRONMENT_REF", help = ENVIRONMENT_ARG_HELP)]
    environment: String,
    /// Secret key name.
    key: String,
    /// Print the actual value after interactive password confirmation.
    #[arg(long)]
    reveal: bool,
    /// Show an earlier version instead of the current one.
    #[arg(long, value_name = "N", value_parser = clap::value_parser!(i64).range(1..))]
    version: Option<i64>,
  },
  /// List the stored versions of a secret, newest first (values are never shown).
  #[command(after_help = HISTORY_HELP)]
  History {
    #[arg(value_name = "ENVIRONMENT_REF", help = ENVIRONMENT_ARG_HELP)]
    environment: String,
    /// Secret key name.
    key: String,
    /// Versions per page, 1 to 200.
    #[arg(long, value_name = "N", default_value_t = HISTORY_LIMIT, value_parser = clap::value_parser!(u32).range(1..=200))]
    limit: u32,
    /// Show only versions older than this one (for the next page).
    #[arg(long, value_name = "VERSION", value_parser = clap::value_parser!(i64).range(1..))]
    before: Option<i64>,
  },
  /// Restore an earlier value of a secret by saving it as a new version.
  ///
  /// Without VERSION, pick one from a list. Shows the current and chosen
  /// versions and asks for confirmation unless --yes is passed.
  #[command(after_help = ROLLBACK_HELP)]
  Rollback {
    #[arg(value_name = "ENVIRONMENT_REF", help = ENVIRONMENT_ARG_HELP)]
    environment: String,
    /// Secret key name.
    key: String,
    /// The version whose value becomes current again.
    #[arg(value_name = "VERSION", value_parser = clap::value_parser!(i64).range(1..))]
    version: Option<i64>,
    /// Skip the confirmation prompt (for automation). Requires VERSION.
    #[arg(long)]
    yes: bool,
  },
  /// Delete a secret from an environment.
  ///
  /// Asks for confirmation unless --yes is passed.
  #[command(after_help = DELETE_HELP)]
  Delete {
    #[arg(value_name = "ENVIRONMENT_REF", help = ENVIRONMENT_ARG_HELP)]
    environment: String,
    /// Secret key name.
    key: String,
    /// Skip the confirmation prompt (for automation).
    #[arg(long)]
    yes: bool,
  },
}

pub(crate) const HELP: &str = "\
Examples:
  dopbase secret list payment-service/production
  dopbase secret set payment-service/production API_KEY
  dopbase secret get payment-service/production API_KEY
  dopbase secret get payment-service/production API_KEY --reveal
  dopbase secret delete payment-service/production API_KEY
  dopbase secret history payment-service/production API_KEY
  dopbase secret rollback payment-service/production API_KEY

Use PROJECT_REF/ENVIRONMENT_NAME for readable references. PROJECT_REF can be a
project ID or name. Immutable environment IDs such as env_482731 also work.
";
const LIST_HELP: &str = "\
Examples:
  dopbase secret list payment-service/production
  dopbase secret list env_482731

Run `dopbase env list` to find an environment.
";
const SET_HELP: &str = "\
Examples:
  dopbase secret set payment-service/production API_KEY
  dopbase secret set payment-service/production API_KEY --stdin
  printf '%s' \"$API_KEY\" | dopbase secret set payment-service/production API_KEY --stdin

Without --stdin, Dopbase uses a masked prompt and displays * for each character.

With --stdin, Dopbase reads the value until EOF. In a terminal, paste or type
the value, then press Ctrl+D. On Windows, press Ctrl+Z, then Enter. Piped input
is read exactly as supplied.
";
pub(crate) const HISTORY_LIMIT: u32 = 50;
const GET_HELP: &str = "\
Examples:
  dopbase secret get payment-service/production API_KEY
  dopbase secret get payment-service/production API_KEY --reveal
  dopbase secret get payment-service/production API_KEY --version 3 --reveal
";
const HISTORY_HELP: &str = "\
Examples:
  dopbase secret history payment-service/production API_KEY
  dopbase secret history payment-service/production API_KEY --limit 10
  dopbase secret history payment-service/production API_KEY --before 41

STATUS is `current` for the value in use, `available` for versions you can
roll back to, and `expired` once retention has removed the value. When more
versions exist, the command for the next page is printed to standard error.
With --json, the API page is printed unchanged.
";
const ROLLBACK_HELP: &str = "\
Examples:
  dopbase secret rollback payment-service/production API_KEY
  dopbase secret rollback payment-service/production API_KEY 3
  dopbase secret rollback payment-service/production API_KEY 3 --yes

The value of the chosen version is saved as a new version. History is never
changed, so a rollback can itself be rolled back. Running `dopbase run`
processes keep the old value until they restart.
";
const DELETE_HELP: &str = "\
Examples:
  dopbase secret delete payment-service/production API_KEY
  dopbase secret delete payment-service/production API_KEY --yes
";
