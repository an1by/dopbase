use sqlx::{SqliteConnection, SqlitePool};

const USER_COLUMNS: &str = "a.id,a.email,a.role,a.created_at,a.updated_at,a.password_hash<>'' AS has_password,EXISTS(SELECT 1 FROM admin_identities i WHERE i.admin_id=a.id) AS sso_linked";

/// id, email, role, created_at, updated_at, has_password, sso_linked.
pub type UserRow = (String, String, String, String, String, bool, bool);

/// Root first, then admins, then members, each by email.
pub async fn list(pool: &SqlitePool) -> Result<Vec<UserRow>, sqlx::Error> {
  // TODO(rbac): orders by the fixed roles. Order by role rank from the role
  // tables once roles are configurable.
  sqlx::query_as(&format!(
    "SELECT {USER_COLUMNS} FROM admins a ORDER BY CASE a.role WHEN 'root' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, a.email"
  ))
  .fetch_all(pool)
  .await
}

pub async fn find(
  pool: &SqlitePool,
  id: &str,
) -> Result<Option<UserRow>, sqlx::Error> {
  sqlx::query_as(&format!("SELECT {USER_COLUMNS} FROM admins a WHERE a.id=?"))
    .bind(id)
    .fetch_optional(pool)
    .await
}

/// The email and role of an account.
pub async fn account(
  pool: &SqlitePool,
  id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
  sqlx::query_as("SELECT email,role FROM admins WHERE id=?")
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub async fn role(
  pool: &SqlitePool,
  id: &str,
) -> Result<Option<String>, sqlx::Error> {
  sqlx::query_scalar("SELECT role FROM admins WHERE id=?")
    .bind(id)
    .fetch_optional(pool)
    .await
}

pub struct NewUser<'a> {
  pub id: &'a str,
  pub email: &'a str,
  pub password_hash: &'a str,
  pub role: &'a str,
  pub now: &'a str,
}

/// Fails with a unique violation when the email is taken.
pub async fn insert(
  conn: &mut SqliteConnection,
  user: NewUser<'_>,
) -> Result<(), sqlx::Error> {
  sqlx::query(
    "INSERT INTO admins(id,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  )
  .bind(user.id)
  .bind(user.email)
  .bind(user.password_hash)
  .bind(user.role)
  .bind(user.now)
  .bind(user.now)
  .execute(conn)
  .await?;
  Ok(())
}

/// Leaves the password unchanged when `password_hash` is `None`. Fails with
/// a unique violation when the email is taken.
pub async fn update(
  conn: &mut SqliteConnection,
  id: &str,
  email: &str,
  password_hash: Option<&str>,
  role: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  match password_hash {
    Some(hash) => {
      sqlx::query("UPDATE admins SET email=?,password_hash=?,role=?,updated_at=? WHERE id=?")
        .bind(email)
        .bind(hash)
        .bind(role)
        .bind(now)
        .bind(id)
        .execute(conn)
        .await?
    }
    None => {
      sqlx::query("UPDATE admins SET email=?,role=?,updated_at=? WHERE id=?")
        .bind(email)
        .bind(role)
        .bind(now)
        .bind(id)
        .execute(conn)
        .await?
    }
  };
  Ok(())
}

pub async fn revoke_sessions(
  conn: &mut SqliteConnection,
  id: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE sessions SET revoked_at=? WHERE admin_id=? AND revoked_at IS NULL")
    .bind(now)
    .bind(id)
    .execute(conn)
    .await?;
  Ok(())
}

/// Only admins and members can be deleted.
pub async fn delete(
  conn: &mut SqliteConnection,
  id: &str,
) -> Result<(), sqlx::Error> {
  // TODO(rbac): protects root by its fixed role name. Protect whichever
  // accounts may not be deleted once roles are configurable.
  sqlx::query("DELETE FROM admins WHERE id=? AND role IN ('admin','member')")
    .bind(id)
    .execute(conn)
    .await?;
  Ok(())
}
