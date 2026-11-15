pub async fn admin_count(pool: &sqlx::SqlitePool) -> Result<i64, sqlx::Error> {
  sqlx::query_scalar("SELECT COUNT(*) FROM accounts")
    .fetch_one(pool)
    .await
}
pub async fn insert_admin(
  tx: &mut sqlx::SqliteConnection,
  id: &str,
  email: &str,
  password_hash: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query(
    "INSERT INTO accounts(id,kind,is_root,created_at,updated_at) VALUES($1,'user',1,$2,$3)",
  )
  .bind(id)
  .bind(now)
  .bind(now)
  .execute(&mut *tx)
  .await?;
  sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)")
    .bind(id)
    .bind(email)
    .bind(password_hash)
    .execute(&mut *tx)
    .await
    .map(|_| ())
}
