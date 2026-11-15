use super::model::EnvironmentResponse;
use sqlx::SqlitePool;
/// One environment, with `secret_count` left at 0. Access checks load it on
/// every secret request, so counting here would be wasted; single responses
/// fill it in with [`secret_count`].
const SELECT: &str = "SELECT e.id,e.project_id,p.name AS project_name,e.name,e.protected,0 AS secret_count,e.created_at,e.updated_at FROM environments e JOIN projects p ON p.id=e.project_id";
/// The same with the secret count, for lists.
const SELECT_COUNTED: &str = "SELECT e.id,e.project_id,p.name AS project_name,e.name,e.protected,(SELECT COUNT(*) FROM secrets s WHERE s.environment_id=e.id) AS secret_count,e.created_at,e.updated_at FROM environments e JOIN projects p ON p.id=e.project_id";

pub async fn insert(
  tx: &mut sqlx::SqliteConnection,
  id: &str,
  project_id: &str,
  name: &str,
  protected: bool,
  now: &str,
) -> Result<bool, sqlx::Error> {
  let result = sqlx::query(
    "INSERT INTO environments(id,project_id,name,protected,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
  )
  .bind(id)
  .bind(project_id)
  .bind(name)
  .bind(protected)
  .bind(now)
  .bind(now)
  .execute(&mut *tx)
  .await?;
  Ok(result.rows_affected() == 1)
}

pub async fn find_id<'e>(
  executor: impl sqlx::SqliteExecutor<'e>,
  id: &str,
) -> Result<Option<EnvironmentResponse>, sqlx::Error> {
  sqlx::query_as(&format!("{SELECT} WHERE e.id=$1"))
    .bind(id)
    .fetch_optional(executor)
    .await
}
pub async fn secret_count<'e>(
  executor: impl sqlx::SqliteExecutor<'e>,
  id: &str,
) -> Result<i64, sqlx::Error> {
  sqlx::query_scalar("SELECT COUNT(*) FROM secrets WHERE environment_id=$1")
    .bind(id)
    .fetch_one(executor)
    .await
}
pub async fn resolve(
  pool: &SqlitePool,
  reference: &str,
) -> Result<Option<EnvironmentResponse>, sqlx::Error> {
  if reference.starts_with("env_") {
    return find_id(pool, reference).await;
  }
  let Some((project, environment)) = reference.split_once('/') else {
    return Ok(None);
  };
  sqlx::query_as(&format!(
    "{SELECT} WHERE (p.id=$1 OR p.name=$2) AND e.name=$3"
  ))
  .bind(project)
  .bind(project)
  .bind(environment)
  .fetch_optional(pool)
  .await
}
pub async fn list(
  pool: &SqlitePool,
  project: Option<&str>,
) -> Result<Vec<EnvironmentResponse>, sqlx::Error> {
  match project {
    Some(value) => {
      sqlx::query_as(&format!(
        "{SELECT_COUNTED} WHERE p.id=$1 OR p.name=$2 ORDER BY p.name,e.name"
      ))
      .bind(value)
      .bind(value)
      .fetch_all(pool)
      .await
    }
    None => {
      sqlx::query_as(&format!("{SELECT_COUNTED} ORDER BY p.name,e.name"))
        .fetch_all(pool)
        .await
    }
  }
}
