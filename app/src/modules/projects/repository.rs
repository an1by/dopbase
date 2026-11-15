use super::model::ProjectResponse;
use sqlx::SqlitePool;
pub async fn list(pool: &SqlitePool) -> Result<Vec<ProjectResponse>, sqlx::Error> {
  sqlx::query_as("SELECT id,name,created_at,updated_at FROM projects ORDER BY name")
    .fetch_all(pool)
    .await
}
pub async fn find(
  pool: &SqlitePool,
  reference: &str,
) -> Result<Option<ProjectResponse>, sqlx::Error> {
  sqlx::query_as("SELECT id,name,created_at,updated_at FROM projects WHERE id=$1 OR name=$2")
    .bind(reference)
    .bind(reference)
    .fetch_optional(pool)
    .await
}
pub async fn insert(
  tx: &mut sqlx::SqliteConnection,
  id: &str,
  name: &str,
  now: &str,
) -> Result<ProjectResponse, sqlx::Error> {
  sqlx::query("INSERT INTO projects(id,name,created_at,updated_at)VALUES($1,$2,$3,$4)")
    .bind(id)
    .bind(name)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
  Ok(ProjectResponse {
    id: id.into(),
    name: name.into(),
    level: Default::default(),
    created_at: now.into(),
    updated_at: now.into(),
  })
}

pub async fn name_taken_in_workspace(
  pool: &SqlitePool,
  workspace_id: &str,
  name: &str,
  exclude_project_id: Option<&str>,
) -> Result<bool, sqlx::Error> {
  let taken: bool = match exclude_project_id {
    Some(project_id) => {
      sqlx::query_scalar(
        "SELECT EXISTS(
         SELECT 1 FROM projects p
         INNER JOIN project_locations l ON l.project_id = p.id
         WHERE l.workspace_id = ? AND p.name = ? AND p.id != ?)",
      )
      .bind(workspace_id)
      .bind(name)
      .bind(project_id)
      .fetch_one(pool)
      .await?
    }
    None => {
      sqlx::query_scalar(
        "SELECT EXISTS(
         SELECT 1 FROM projects p
         INNER JOIN project_locations l ON l.project_id = p.id
         WHERE l.workspace_id = ? AND p.name = ?)",
      )
      .bind(workspace_id)
      .bind(name)
      .fetch_one(pool)
      .await?
    }
  };
  Ok(taken)
}
