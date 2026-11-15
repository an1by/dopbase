pub async fn initialized(pool: &sqlx::SqlitePool) -> Result<bool, sqlx::Error> {
  sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM accounts")
    .fetch_one(pool)
    .await
    .map(|count| count > 0)
}
