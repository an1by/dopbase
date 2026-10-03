use super::model::ProjectResponse;
use sqlx::{Sqlite, SqlitePool, Transaction};
pub async fn list(pool: &SqlitePool) -> Result<Vec<ProjectResponse>, sqlx::Error> {
  sqlx::query_as("SELECT p.id,p.name,l.workspace_id,l.relative_path,p.created_at,p.updated_at FROM projects p LEFT JOIN project_locations l ON l.project_id=p.id ORDER BY p.name")
    .fetch_all(pool)
    .await
}
pub async fn find(
  pool: &SqlitePool,
  reference: &str,
) -> Result<Option<ProjectResponse>, sqlx::Error> {
  sqlx::query_as("SELECT p.id,p.name,l.workspace_id,l.relative_path,p.created_at,p.updated_at FROM projects p LEFT JOIN project_locations l ON l.project_id=p.id WHERE p.id=? OR p.name=?")
    .bind(reference)
    .bind(reference)
    .fetch_optional(pool)
    .await
}
pub async fn insert(
  tx: &mut Transaction<'_, Sqlite>,
  id: &str,
  name: &str,
  now: &str,
) -> Result<ProjectResponse, sqlx::Error> {
  sqlx::query("INSERT INTO projects(id,name,created_at,updated_at)VALUES(?,?,?,?)")
    .bind(id)
    .bind(name)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
  Ok(ProjectResponse {
    id: id.into(),
    name: name.into(),
    workspace_id: None,
    relative_path: None,
    created_at: now.into(),
    updated_at: now.into(),
  })
}
