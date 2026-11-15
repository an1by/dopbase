use sqlx::{SqliteConnection, SqlitePool};
pub async fn admin_by_email(
  pool: &SqlitePool,
  email: &str,
) -> Result<Option<(String, String, String, String)>, sqlx::Error> {
  sqlx::query_as(concat!(
    "SELECT u.id, u.email, COALESCE(u.password_hash, ''), ",
    crate::legacy_role_sql!("a"),
    " FROM users u JOIN accounts a ON a.id = u.id WHERE lower(u.email) = lower($1)"
  ))
  .bind(email)
  .fetch_optional(pool)
  .await
}
pub async fn password_hash(
  pool: &SqlitePool,
  id: &str,
) -> Result<Option<String>, sqlx::Error> {
  sqlx::query_scalar("SELECT COALESCE(password_hash, '') FROM users WHERE id = $1")
    .bind(id)
    .fetch_optional(pool)
    .await
}

/// Drops session history older than `cutoff`: revoked, idle, or past its
/// absolute lifetime. The idle deadline never passes the absolute one (a
/// CHECK says so), so testing it covers both.
pub async fn prune_sessions(
  conn: &mut SqliteConnection,
  cutoff: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("DELETE FROM sessions WHERE revoked_at < $1 OR idle_expires_at < $1")
    .bind(cutoff)
    .execute(conn)
    .await?;
  Ok(())
}

pub struct NewSession<'a> {
  pub id: &'a str,
  pub admin_id: &'a str,
  pub kind: &'a str,
  pub token_hash: &'a [u8],
  pub csrf_hash: Option<&'a [u8]>,
  pub now: &'a str,
  pub idle_expires_at: &'a str,
  pub absolute_expires_at: &'a str,
}

/// A new session counts as recently authenticated.
pub async fn insert_session(
  conn: &mut SqliteConnection,
  session: NewSession<'_>,
) -> Result<(), sqlx::Error> {
  sqlx::query("INSERT INTO sessions(id,user_id,kind,token_hash,csrf_hash,created_at,last_used_at,recent_auth_at,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
    .bind(session.id)
    .bind(session.admin_id)
    .bind(session.kind)
    .bind(session.token_hash)
    .bind(session.csrf_hash)
    .bind(session.now)
    .bind(session.now)
    .bind(session.now)
    .bind(session.idle_expires_at)
    .bind(session.absolute_expires_at)
    .execute(conn)
    .await?;
  Ok(())
}

/// Records an interactive sign-in on the account.
pub async fn mark_signed_in(
  conn: &mut SqliteConnection,
  admin_id: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE users SET last_sign_in_at=$1 WHERE id=$2")
    .bind(now)
    .bind(admin_id)
    .execute(conn)
    .await?;
  Ok(())
}

pub async fn revoke_session(
  conn: &mut SqliteConnection,
  session_id: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE sessions SET revoked_at=$1 WHERE id=$2")
    .bind(now)
    .bind(session_id)
    .execute(conn)
    .await?;
  Ok(())
}

pub async fn revoke_sessions_of(
  conn: &mut SqliteConnection,
  admin_id: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE sessions SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL")
    .bind(now)
    .bind(admin_id)
    .execute(conn)
    .await?;
  Ok(())
}

pub async fn mark_recent_auth(
  conn: &mut SqliteConnection,
  session_id: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE sessions SET recent_auth_at=$1 WHERE id=$2")
    .bind(now)
    .bind(session_id)
    .execute(conn)
    .await?;
  Ok(())
}

/// Confirms a CLI session that still belongs to `admin_id` and is not
/// revoked. Returns whether one was found.
pub async fn confirm_session_of(
  conn: &mut SqliteConnection,
  session_id: Option<&str>,
  admin_id: &str,
  now: &str,
) -> Result<bool, sqlx::Error> {
  let updated = sqlx::query(
    "UPDATE sessions SET recent_auth_at=$1 WHERE id=$2 AND user_id=$3 AND revoked_at IS NULL",
  )
  .bind(now)
  .bind(session_id)
  .bind(admin_id)
  .execute(conn)
  .await?
  .rows_affected();
  Ok(updated > 0)
}

pub async fn set_password_hash(
  conn: &mut SqliteConnection,
  admin_id: &str,
  hash: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE users SET password_hash=$1 WHERE id=$2")
    .bind(hash)
    .bind(admin_id)
    .execute(&mut *conn)
    .await?;
  sqlx::query("UPDATE accounts SET updated_at=$1 WHERE id=$2")
    .bind(now)
    .bind(admin_id)
    .execute(&mut *conn)
    .await?;
  Ok(())
}

/// The email and role of an active account. A disabled one gets `None`, so
/// a login it approved before being disabled issues no session.
pub async fn account(
  conn: &mut SqliteConnection,
  admin_id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
  sqlx::query_as(concat!(
    "SELECT u.email, ",
    crate::legacy_role_sql!("a"),
    " FROM users u JOIN accounts a ON a.id = u.id WHERE u.id = $1 AND a.status = 'active'"
  ))
  .bind(admin_id)
  .fetch_optional(conn)
  .await
}

/// Expired device requests stay for an hour so a late poll still reads
/// "expired" rather than "invalid", then go.
pub async fn delete_stale_device_requests(
  conn: &mut SqliteConnection,
  cutoff: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("DELETE FROM cli_device_requests WHERE expires_at < $1")
    .bind(cutoff)
    .execute(conn)
    .await?;
  Ok(())
}

/// Requests still waiting for approval overall and from `client_ip`.
pub async fn pending_device_requests(
  conn: &mut SqliteConnection,
  client_ip: Option<&str>,
  now: &str,
) -> Result<(i64, i64), sqlx::Error> {
  sqlx::query_as(
    "SELECT COUNT(*), COALESCE(SUM(CASE WHEN client_ip = $1 OR (client_ip IS NULL AND $1 IS NULL) THEN 1 ELSE 0 END), 0) FROM cli_device_requests WHERE status = 'pending' AND expires_at > $2",
  )
  .bind(client_ip)
  .bind(now)
  .fetch_one(conn)
  .await
}

pub struct NewDeviceRequest<'a> {
  pub id: &'a str,
  pub device_code_hash: &'a [u8],
  pub user_code_hash: &'a [u8],
  pub purpose: &'a str,
  pub target_session_id: Option<&'a str>,
  pub client_hostname: Option<&'a str>,
  pub client_name: Option<&'a str>,
  pub client_ip: Option<&'a str>,
  pub now: &'a str,
  pub expires_at: &'a str,
}

/// Returns false when the user code is already taken.
pub async fn insert_device_request(
  conn: &mut SqliteConnection,
  request: NewDeviceRequest<'_>,
) -> Result<bool, sqlx::Error> {
  let inserted = sqlx::query("INSERT INTO cli_device_requests(id,device_code_hash,user_code_hash,status,purpose,target_session_id,client_hostname,client_name,client_ip,created_at,expires_at) VALUES($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(user_code_hash) DO NOTHING")
    .bind(request.id)
    .bind(request.device_code_hash)
    .bind(request.user_code_hash)
    .bind(request.purpose)
    .bind(request.target_session_id)
    .bind(request.client_hostname)
    .bind(request.client_name)
    .bind(request.client_ip)
    .bind(request.now)
    .bind(request.expires_at)
    .execute(conn)
    .await?
    .rows_affected();
  Ok(inserted == 1)
}

#[derive(sqlx::FromRow)]
pub struct DeviceRow {
  pub id: String,
  pub status: String,
  pub expires_at: String,
  pub last_polled_at: Option<String>,
}

pub async fn device_request(
  pool: &SqlitePool,
  device_code_hash: &[u8],
) -> Result<Option<DeviceRow>, sqlx::Error> {
  sqlx::query_as(
    "SELECT id,status,expires_at,last_polled_at FROM cli_device_requests WHERE device_code_hash=$1",
  )
  .bind(device_code_hash)
  .fetch_optional(pool)
  .await
}

pub async fn touch_device_request(
  pool: &SqlitePool,
  id: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE cli_device_requests SET last_polled_at=$1 WHERE id=$2")
    .bind(now)
    .bind(id)
    .execute(pool)
    .await?;
  Ok(())
}

/// Flips an approved request to consumed in the statement that checks it,
/// so two racing polls cannot both receive a session. Returns who approved
/// it, its purpose, and the CLI session a confirmation is for.
pub async fn consume_device_request(
  conn: &mut SqliteConnection,
  id: &str,
) -> Result<Option<(Option<String>, String, Option<String>)>, sqlx::Error> {
  sqlx::query_as(
    "UPDATE cli_device_requests SET status='consumed' WHERE id=$1 AND status='approved' RETURNING approved_by,purpose,target_session_id",
  )
  .bind(id)
  .fetch_optional(conn)
  .await
}

pub async fn cancel_device_request(
  pool: &SqlitePool,
  device_code_hash: &[u8],
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE cli_device_requests SET status='cancelled',decided_at=$1 WHERE device_code_hash=$2 AND status IN ('pending','approved')")
    .bind(now)
    .bind(device_code_hash)
    .execute(pool)
    .await?;
  Ok(())
}

/// A login can be approved by anyone signed in; a confirmation only by the
/// owner of the CLI session it confirms. `$approver` binds the approver's
/// account ID.
macro_rules! owned_by_approver {
  ($approver:literal) => {
    concat!(
      "(purpose = 'login' OR target_session_id IN (SELECT id FROM sessions WHERE user_id = ",
      $approver,
      "))"
    )
  };
}

#[derive(sqlx::FromRow)]
pub struct PendingDeviceRow {
  pub client_hostname: Option<String>,
  pub client_name: Option<String>,
  pub client_ip: Option<String>,
  pub created_at: String,
  pub expires_at: String,
  pub purpose: String,
}

/// A pending request `approver_id` may decide on.
pub async fn pending_device_request(
  pool: &SqlitePool,
  user_code_hash: &[u8],
  approver_id: &str,
  now: &str,
) -> Result<Option<PendingDeviceRow>, sqlx::Error> {
  sqlx::query_as(concat!(
    "SELECT client_hostname, client_name, client_ip, created_at, expires_at, purpose FROM cli_device_requests WHERE user_code_hash = $1 AND status = 'pending' AND expires_at > $2 AND ",
    owned_by_approver!("$3")
  ))
  .bind(user_code_hash)
  .bind(now)
  .bind(approver_id)
  .fetch_optional(pool)
  .await
}

/// Approves or denies a pending request `approver_id` may decide on.
/// Returns its ID and client hostname.
pub async fn decide_device_request(
  conn: &mut SqliteConnection,
  user_code_hash: &[u8],
  approver_id: &str,
  approve: bool,
  now: &str,
) -> Result<Option<(String, Option<String>)>, sqlx::Error> {
  sqlx::query_as(concat!(
    "UPDATE cli_device_requests SET status = $1, approved_by = $2, decided_at = $3 WHERE user_code_hash = $4 AND status = 'pending' AND expires_at > $5 AND ",
    owned_by_approver!("$6"),
    " RETURNING id, client_hostname"
  ))
  .bind(if approve { "approved" } else { "denied" })
  .bind(approve.then_some(approver_id))
  .bind(now)
  .bind(user_code_hash)
  .bind(now)
  .bind(approver_id)
  .fetch_optional(conn)
  .await
}

/// What a role's personal tokens are for.
pub async fn token_scope(
  pool: &sqlx::SqlitePool,
  role_id: &str,
) -> Result<Option<String>, sqlx::Error> {
  sqlx::query_scalar("SELECT token_scope FROM roles WHERE id = $1")
    .bind(role_id)
    .fetch_optional(pool)
    .await
}
