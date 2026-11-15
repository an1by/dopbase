//! Access resolution: what one caller can reach, worked out once per
//! request on the connection it is given, and asked about each project and
//! environment. Services ask it instead of loading grants, owners and the
//! project list themselves. The level arithmetic underneath stays in
//! [`authx`]; this module owns loading it and the rules around it:
//!
//! - an environment the caller can't reach is hidden, not forbidden, so its
//!   existence doesn't leak;
//! - reaching any environment of a project shows the project, at Metadata;
//! - an AI agent's token never reaches more than its owner, and a personal
//!   token never more than its account or its own limit;
//! - which features are on is already applied inside the caller's access.
//!
//! Load it on the write transaction when the answer guards a write, so a
//! grant revoked a moment earlier is seen.

use sqlx::SqliteConnection;

use super::authx::{self, Catalog, DataAccess, EnvironmentTarget, Level};
use crate::{constants::errors::AUTHORIZATION_DENIED, http::HttpError, models::AuthIdentity};

/// Why a caller can't have what they asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
  /// The caller can't see it at all; answer as if it didn't exist.
  Hidden,
  /// The caller sees it but their level is too low.
  Denied,
}

/// What a refusal is about, for the HTTP answer.
#[derive(Clone, Copy, Debug)]
pub enum Resource {
  Project,
  Environment,
}

impl Refusal {
  pub fn into_http(
    self,
    resource: Resource,
  ) -> HttpError {
    match (self, resource) {
      (Self::Hidden, Resource::Project) => {
        HttpError::not_found("PROJECT_NOT_FOUND", "The requested project was not found.")
      }
      (Self::Hidden, Resource::Environment) => HttpError::not_found(
        "ENVIRONMENT_NOT_FOUND",
        "The requested environment was not found.",
      ),
      (Self::Denied, Resource::Project) => HttpError::forbidden(
        AUTHORIZATION_DENIED,
        "Your access to this project does not allow this.",
      ),
      (Self::Denied, Resource::Environment) => HttpError::forbidden(
        AUTHORIZATION_DENIED,
        "Your access to this environment does not allow this.",
      ),
    }
  }
}

/// One caller's reach over every project and environment.
pub struct Reach {
  data: DataAccess,
  catalog: Catalog,
}

impl Reach {
  /// Loads the caller's grants (and an agent's owner's) and the project
  /// list, on `conn`.
  pub async fn load(
    conn: &mut SqliteConnection,
    identity: &AuthIdentity,
  ) -> Result<Self, sqlx::Error> {
    let data = authx::data_access(conn, identity).await?;
    let catalog = Catalog::load(conn).await?;
    Ok(Self { data, catalog })
  }

  /// Like [`Reach::load`], but knowing only `project_id` and its
  /// environments. For checks on one project or one of its environments,
  /// which then skip reading every project and environment. Anything
  /// outside that project reads as hidden.
  pub async fn load_project(
    conn: &mut SqliteConnection,
    identity: &AuthIdentity,
    project_id: &str,
  ) -> Result<Self, sqlx::Error> {
    let data = authx::data_access(conn, identity).await?;
    let catalog = Catalog::load_project(conn, project_id).await?;
    Ok(Self { data, catalog })
  }

  /// The reach of an account by itself, as its role and grants give it,
  /// with no token limit. For judging other accounts.
  pub async fn of_account(
    conn: &mut SqliteConnection,
    admin_id: &str,
    access: &authx::Access,
  ) -> Result<Self, sqlx::Error> {
    let data = authx::account_data_access(conn, admin_id, access).await?;
    let catalog = Catalog::load(conn).await?;
    Ok(Self { data, catalog })
  }

  pub fn data(&self) -> &DataAccess {
    &self.data
  }

  pub fn catalog(&self) -> &Catalog {
    &self.catalog
  }

  fn target(
    &self,
    environment_id: &str,
  ) -> Option<EnvironmentTarget<'_>> {
    self.catalog.find_environment(environment_id)
  }

  /// The level on an environment; `None` when it doesn't exist.
  pub fn environment(
    &self,
    environment_id: &str,
  ) -> Option<Level> {
    self
      .target(environment_id)
      .map(|target| self.data.environment(target))
  }

  /// The level on an environment the caller already has the row for.
  pub fn environment_of(
    &self,
    target: EnvironmentTarget<'_>,
  ) -> Level {
    self.data.environment(target)
  }

  /// The level on a project; `None` when the caller can't see it.
  /// Reaching only some environments counts as Metadata on the project.
  pub fn project(
    &self,
    project_id: &str,
  ) -> Option<Level> {
    if !self.catalog.projects.iter().any(|id| id == project_id) {
      return None;
    }
    let level = self.data.project(project_id);
    if level > Level::None {
      Some(level)
    } else if self
      .data
      .sees_project(project_id, self.catalog.environments_of(project_id))
    {
      Some(Level::Metadata)
    } else {
      None
    }
  }

  /// The level on an environment if it reaches `needed`.
  pub fn require_environment(
    &self,
    environment_id: &str,
    needed: Level,
  ) -> Result<Level, Refusal> {
    match self.environment(environment_id) {
      None | Some(Level::None) => Err(Refusal::Hidden),
      Some(level) if level < needed => Err(Refusal::Denied),
      Some(level) => Ok(level),
    }
  }

  /// The level on a project if it reaches `needed`.
  pub fn require_project(
    &self,
    project_id: &str,
    needed: Level,
  ) -> Result<Level, Refusal> {
    match self.project(project_id) {
      None => Err(Refusal::Hidden),
      Some(level) if level < needed => Err(Refusal::Denied),
      Some(level) => Ok(level),
    }
  }

  /// Every project the caller can see.
  pub fn visible_projects(&self) -> Vec<String> {
    self
      .catalog
      .projects
      .iter()
      .filter(|id| self.project(id).is_some())
      .cloned()
      .collect()
  }

  /// Environments inside the visible projects that the caller can't reach,
  /// such as a protected one their project grant stops at. Lists built from
  /// visible projects must leave these out.
  pub fn hidden_environments(&self) -> Vec<String> {
    let visible = self.visible_projects();
    self
      .catalog
      .environments()
      .into_iter()
      .filter(|target| visible.iter().any(|id| id == target.project_id))
      .filter(|target| self.data.environment(*target) == Level::None)
      .map(|target| target.environment_id.to_owned())
      .collect()
  }

  /// Whether this reach is at least `other`'s on every project and
  /// environment. Stops an account from managing someone with more access.
  pub fn covers(
    &self,
    other: &DataAccess,
  ) -> bool {
    self
      .data
      .covers(other, &self.catalog.projects, &self.catalog.environments())
  }
}
