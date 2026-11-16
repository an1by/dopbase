use super::Workspace;
use sqlx::SqlitePool;

pub async fn list(pool: &SqlitePool) -> Result<Vec<Workspace>, sqlx::Error> {
  sqlx::query_as("SELECT id, name, root_path, created_at, updated_at FROM workspaces ORDER BY name")
    .fetch_all(pool)
    .await
}

pub async fn insert(
  conn: &mut sqlx::SqliteConnection,
  id: &str,
  name: &str,
  root_path: &str,
  now: &str,
) -> Result<Workspace, sqlx::Error> {
  sqlx::query_as(
    "INSERT INTO workspaces(id, name, root_path, created_at, updated_at) VALUES($1, $2, $3, $4, $5) RETURNING *",
  )
  .bind(id)
  .bind(name)
  .bind(root_path)
  .bind(now)
  .bind(now)
  .fetch_one(&mut *conn)
  .await
}

pub async fn update(
  conn: &mut sqlx::SqliteConnection,
  id: &str,
  name: &str,
  root_path: &str,
  now: &str,
) -> Result<Option<Workspace>, sqlx::Error> {
  sqlx::query_as(
    "UPDATE workspaces SET name = $1, root_path = $2, updated_at = $3 WHERE id = $4 RETURNING *",
  )
  .bind(name)
  .bind(root_path)
  .bind(now)
  .bind(id)
  .fetch_optional(&mut *conn)
  .await
}

pub async fn project_count(
  conn: &mut sqlx::SqliteConnection,
  id: &str,
) -> Result<i64, sqlx::Error> {
  sqlx::query_scalar("SELECT COUNT(*) FROM project_locations WHERE workspace_id = $1")
    .bind(id)
    .fetch_one(&mut *conn)
    .await
}

pub async fn delete(
  conn: &mut sqlx::SqliteConnection,
  id: &str,
) -> Result<u64, sqlx::Error> {
  Ok(
    sqlx::query("DELETE FROM workspaces WHERE id = $1")
      .bind(id)
      .execute(&mut *conn)
      .await?
      .rows_affected(),
  )
}
