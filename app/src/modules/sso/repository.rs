use sqlx::{SqliteConnection, SqlitePool};

#[derive(sqlx::FromRow)]
pub struct ProviderRow {
  pub id: String,
  pub preset: String,
  pub display_name: String,
  pub issuer: String,
  pub client_id: String,
  pub client_secret_ciphertext: Vec<u8>,
  pub client_secret_nonce: Vec<u8>,
  pub enabled: bool,
  pub require_sso: bool,
  pub hide_password_form: bool,
  pub verified_at: Option<String>,
  pub updated_at: String,
}

const PROVIDER_COLUMNS: &str = "id,preset,display_name,issuer,client_id,client_secret_ciphertext,client_secret_nonce,enabled,require_sso,hide_password_form,verified_at,updated_at";

/// Version 1 has one provider, so this is the first one created.
pub async fn provider(pool: &SqlitePool) -> Result<Option<ProviderRow>, sqlx::Error> {
  sqlx::query_as(&format!(
    "SELECT {PROVIDER_COLUMNS} FROM sso_providers ORDER BY created_at LIMIT 1"
  ))
  .fetch_optional(pool)
  .await
}

pub async fn provider_by_id(
  pool: &SqlitePool,
  id: &str,
) -> Result<Option<ProviderRow>, sqlx::Error> {
  sqlx::query_as(&format!(
    "SELECT {PROVIDER_COLUMNS} FROM sso_providers WHERE id=$1"
  ))
  .bind(id)
  .fetch_optional(pool)
  .await
}

/// The enabled provider's button label, `require_sso`, and
/// `hide_password_form`.
pub async fn enabled_policy(
  pool: &SqlitePool
) -> Result<Option<(String, bool, bool)>, sqlx::Error> {
  sqlx::query_as(
    "SELECT display_name,require_sso,hide_password_form FROM sso_providers WHERE enabled=1 LIMIT 1",
  )
  .fetch_optional(pool)
  .await
}

/// The enabled provider's button label, when `admin_id` has an identity
/// linked to it.
pub async fn confirmation_name(
  pool: &SqlitePool,
  admin_id: &str,
) -> Result<Option<String>, sqlx::Error> {
  sqlx::query_scalar(
    "SELECT p.display_name FROM sso_providers p JOIN user_identities i ON i.provider_id=p.id WHERE p.enabled=1 AND i.user_id=$1 LIMIT 1",
  )
  .bind(admin_id)
  .fetch_optional(pool)
  .await
}

pub async fn linked_count(
  pool: &SqlitePool,
  provider_id: &str,
) -> Result<i64, sqlx::Error> {
  sqlx::query_scalar("SELECT COUNT(*) FROM user_identities WHERE provider_id=$1")
    .bind(provider_id)
    .fetch_one(pool)
    .await
}

/// People without a password, who can only sign in through single sign-on.
/// Root always has one, and AI agents never sign in.
pub async fn passwordless_count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
  sqlx::query_scalar(
    "SELECT COUNT(*) FROM users u JOIN accounts a ON a.id = u.id JOIN roles r ON r.id = a.role_id WHERE u.password_hash IS NULL AND a.is_root = 0 AND r.sign_in = 'interactive'",
  )
  .fetch_one(pool)
  .await
}

pub struct ProviderFields<'a> {
  pub id: &'a str,
  pub preset: &'a str,
  pub display_name: &'a str,
  pub issuer: &'a str,
  pub client_id: &'a str,
  pub client_secret_ciphertext: &'a [u8],
  pub client_secret_nonce: &'a [u8],
  pub now: &'a str,
}

/// A new provider starts disabled and unverified.
pub async fn insert_provider(
  conn: &mut SqliteConnection,
  fields: ProviderFields<'_>,
) -> Result<(), sqlx::Error> {
  sqlx::query("INSERT INTO sso_providers(id,preset,display_name,issuer,client_id,client_secret_ciphertext,client_secret_nonce,enabled,verified_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,0,NULL,$8,$9)")
    .bind(fields.id)
    .bind(fields.preset)
    .bind(fields.display_name)
    .bind(fields.issuer)
    .bind(fields.client_id)
    .bind(fields.client_secret_ciphertext)
    .bind(fields.client_secret_nonce)
    .bind(fields.now)
    .bind(fields.now)
    .execute(conn)
    .await?;
  Ok(())
}

/// With `reverify`, the provider also goes back to disabled, not required,
/// and unverified until root completes another test sign-in.
pub async fn update_provider(
  conn: &mut SqliteConnection,
  fields: ProviderFields<'_>,
  reverify: bool,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE sso_providers SET preset=$1,display_name=$2,issuer=$3,client_id=$4,client_secret_ciphertext=$5,client_secret_nonce=$6,enabled=CASE WHEN $7 THEN 0 ELSE enabled END,require_sso=CASE WHEN $8 THEN 0 ELSE require_sso END,verified_at=CASE WHEN $9 THEN NULL ELSE verified_at END,updated_at=$10 WHERE id=$11")
    .bind(fields.preset)
    .bind(fields.display_name)
    .bind(fields.issuer)
    .bind(fields.client_id)
    .bind(fields.client_secret_ciphertext)
    .bind(fields.client_secret_nonce)
    .bind(reverify)
    .bind(reverify)
    .bind(reverify)
    .bind(fields.now)
    .bind(fields.id)
    .execute(conn)
    .await?;
  Ok(())
}

/// Turning the provider off also stops requiring it.
pub async fn set_enabled(
  conn: &mut SqliteConnection,
  id: &str,
  enabled: bool,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query(
    "UPDATE sso_providers SET enabled=$1,require_sso=require_sso AND $2,updated_at=$3 WHERE id=$4",
  )
  .bind(enabled)
  .bind(enabled)
  .bind(now)
  .bind(id)
  .execute(conn)
  .await?;
  Ok(())
}

pub async fn set_required(
  conn: &mut SqliteConnection,
  id: &str,
  required: bool,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE sso_providers SET require_sso=$1,updated_at=$2 WHERE id=$3")
    .bind(required)
    .bind(now)
    .bind(id)
    .execute(conn)
    .await?;
  Ok(())
}

pub async fn set_password_form_hidden(
  conn: &mut SqliteConnection,
  id: &str,
  hidden: bool,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE sso_providers SET hide_password_form=$1,updated_at=$2 WHERE id=$3")
    .bind(hidden)
    .bind(now)
    .bind(id)
    .execute(conn)
    .await?;
  Ok(())
}

/// Linked identities and pending sign-ins cascade with it.
pub async fn delete_provider(
  conn: &mut SqliteConnection,
  id: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("DELETE FROM sso_providers WHERE id=$1")
    .bind(id)
    .execute(conn)
    .await?;
  Ok(())
}

/// Records root's first successful test sign-in. Returns whether this call
/// set it.
pub async fn mark_verified(
  conn: &mut SqliteConnection,
  id: &str,
  now: &str,
) -> Result<bool, sqlx::Error> {
  let updated =
    sqlx::query("UPDATE sso_providers SET verified_at=$1 WHERE id=$2 AND verified_at IS NULL")
      .bind(now)
      .bind(id)
      .execute(conn)
      .await?
      .rows_affected();
  Ok(updated == 1)
}

/// Signs out every account except root. Root alone holds
/// password.breakglass, the capability to keep password sign-in while single
/// sign-on is required, and no role can be given it.
pub async fn revoke_non_root_sessions(
  conn: &mut SqliteConnection,
  now: &str,
) -> Result<u64, sqlx::Error> {
  Ok(
    sqlx::query("UPDATE sessions SET revoked_at=$1 WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM accounts WHERE is_root=0)")
      .bind(now)
      .execute(conn)
      .await?
      .rows_affected(),
  )
}

pub struct NewIdentity<'a> {
  pub id: &'a str,
  pub admin_id: &'a str,
  pub provider_id: &'a str,
  pub issuer: &'a str,
  pub subject: &'a str,
  pub email_at_link: Option<&'a str>,
  /// `auto` for a verified email match, `manual` for a link the account
  /// started itself.
  pub linked_via: &'a str,
  pub now: &'a str,
  /// Set when the link happened during a sign-in.
  pub last_login_at: Option<&'a str>,
}

/// Fails with a unique violation when the subject or the account is
/// already linked to this provider.
pub async fn insert_identity(
  conn: &mut SqliteConnection,
  identity: NewIdentity<'_>,
) -> Result<(), sqlx::Error> {
  sqlx::query("INSERT INTO user_identities(id,user_id,provider_id,issuer,subject,email_at_link,linked_via,created_at,last_login_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)")
    .bind(identity.id)
    .bind(identity.admin_id)
    .bind(identity.provider_id)
    .bind(identity.issuer)
    .bind(identity.subject)
    .bind(identity.email_at_link)
    .bind(identity.linked_via)
    .bind(identity.now)
    .bind(identity.last_login_at)
    .execute(conn)
    .await?;
  Ok(())
}

/// The account an (issuer, subject) pair is linked to.
pub async fn identity_owner(
  conn: &mut SqliteConnection,
  issuer: &str,
  subject: &str,
) -> Result<Option<String>, sqlx::Error> {
  sqlx::query_scalar("SELECT user_id FROM user_identities WHERE issuer=$1 AND subject=$2")
    .bind(issuer)
    .bind(subject)
    .fetch_optional(conn)
    .await
}

/// The ID and role of the account an (issuer, subject) pair is linked to.
pub async fn linked_account(
  conn: &mut SqliteConnection,
  issuer: &str,
  subject: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
  sqlx::query_as(
    concat!(
      "SELECT a.id, ",
      crate::legacy_role_sql!("a"),
      " FROM user_identities i JOIN accounts a ON a.id = i.user_id WHERE i.issuer = $1 AND i.subject = $2"
    ),
  )
  .bind(issuer)
  .bind(subject)
  .fetch_optional(conn)
  .await
}

pub async fn touch_identity(
  conn: &mut SqliteConnection,
  issuer: &str,
  subject: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE user_identities SET last_login_at=$1 WHERE issuer=$2 AND subject=$3")
    .bind(now)
    .bind(issuer)
    .bind(subject)
    .execute(conn)
    .await?;
  Ok(())
}

/// The email at link time and the link time of `admin_id`'s identity.
pub async fn identity_of(
  pool: &SqlitePool,
  admin_id: &str,
  provider_id: &str,
) -> Result<Option<(Option<String>, String)>, sqlx::Error> {
  sqlx::query_as(
    "SELECT email_at_link,created_at FROM user_identities WHERE user_id=$1 AND provider_id=$2",
  )
  .bind(admin_id)
  .bind(provider_id)
  .fetch_optional(pool)
  .await
}

/// Removes identities from any other issuer, which can never match a
/// sign-in again. Returns how many went.
pub async fn delete_identities_from_other_issuers(
  conn: &mut SqliteConnection,
  provider_id: &str,
  issuer: &str,
) -> Result<u64, sqlx::Error> {
  Ok(
    sqlx::query("DELETE FROM user_identities WHERE provider_id=$1 AND issuer<>$2")
      .bind(provider_id)
      .bind(issuer)
      .execute(conn)
      .await?
      .rows_affected(),
  )
}

pub async fn delete_identities_of(
  conn: &mut SqliteConnection,
  admin_id: &str,
) -> Result<u64, sqlx::Error> {
  Ok(
    sqlx::query("DELETE FROM user_identities WHERE user_id=$1")
      .bind(admin_id)
      .execute(conn)
      .await?
      .rows_affected(),
  )
}

/// Finished and abandoned sign-ins are cleared on the recurring start path.
pub async fn delete_expired_flows(
  conn: &mut SqliteConnection,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("DELETE FROM sso_flows WHERE expires_at < $1")
    .bind(now)
    .execute(conn)
    .await?;
  Ok(())
}

/// Sign-ins in progress overall and from `client_ip`.
pub async fn pending_flows(
  conn: &mut SqliteConnection,
  client_ip: Option<&str>,
) -> Result<(i64, i64), sqlx::Error> {
  sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(CASE WHEN client_ip = $1 OR (client_ip IS NULL AND $1 IS NULL) THEN 1 ELSE 0 END), 0) FROM sso_flows")
    .bind(client_ip)
    .fetch_one(conn)
    .await
}

pub struct NewFlow<'a> {
  pub id: &'a str,
  pub state_hash: &'a [u8],
  pub provider_id: &'a str,
  pub purpose: &'a str,
  pub nonce: &'a str,
  pub pkce_verifier: &'a str,
  pub binding_hash: &'a [u8],
  pub session_id: Option<&'a str>,
  pub admin_id: Option<&'a str>,
  pub redirect_to: Option<&'a str>,
  pub client_ip: Option<&'a str>,
  pub now: &'a str,
  pub expires_at: &'a str,
}

pub async fn insert_flow(
  conn: &mut SqliteConnection,
  flow: NewFlow<'_>,
) -> Result<(), sqlx::Error> {
  sqlx::query("INSERT INTO sso_flows(id,state_hash,provider_id,purpose,nonce,pkce_verifier,binding_hash,session_id,user_id,redirect_to,client_ip,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)")
    .bind(flow.id)
    .bind(flow.state_hash)
    .bind(flow.provider_id)
    .bind(flow.purpose)
    .bind(flow.nonce)
    .bind(flow.pkce_verifier)
    .bind(flow.binding_hash)
    .bind(flow.session_id)
    .bind(flow.admin_id)
    .bind(flow.redirect_to)
    .bind(flow.client_ip)
    .bind(flow.now)
    .bind(flow.expires_at)
    .execute(conn)
    .await?;
  Ok(())
}

#[derive(sqlx::FromRow)]
pub struct FlowRow {
  pub id: String,
  pub provider_id: String,
  pub purpose: String,
  pub nonce: String,
  pub pkce_verifier: String,
  pub session_id: Option<String>,
  #[sqlx(rename = "user_id")]
  pub admin_id: Option<String>,
  pub created_at: String,
}

/// Marks the flow for this state and browser binding used, in the same
/// statement that finds it, so two racing callbacks cannot both use it.
pub async fn consume_flow(
  pool: &SqlitePool,
  state_hash: &[u8],
  binding_hash: &[u8],
  now: &str,
) -> Result<Option<FlowRow>, sqlx::Error> {
  sqlx::query_as(
    "UPDATE sso_flows SET consumed_at=$1 WHERE state_hash=$2 AND binding_hash=$3 AND consumed_at IS NULL AND expires_at > $4 RETURNING id,provider_id,purpose,nonce,pkce_verifier,session_id,user_id,created_at",
  )
  .bind(now)
  .bind(state_hash)
  .bind(binding_hash)
  .bind(now)
  .fetch_optional(pool)
  .await
}

pub async fn set_handoff(
  conn: &mut SqliteConnection,
  flow_id: &str,
  handoff_hash: &[u8],
  expires_at: &str,
  admin_id: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE sso_flows SET handoff_hash=$1,handoff_expires_at=$2,user_id=$3 WHERE id=$4")
    .bind(handoff_hash)
    .bind(expires_at)
    .bind(admin_id)
    .bind(flow_id)
    .execute(conn)
    .await?;
  Ok(())
}

/// Deletes the login flow holding this handoff code and browser binding,
/// returning its account and redirect. Used once, even under a race.
pub async fn take_handoff(
  conn: &mut SqliteConnection,
  handoff_hash: &[u8],
  binding_hash: &[u8],
  now: &str,
) -> Result<Option<(Option<String>, Option<String>)>, sqlx::Error> {
  sqlx::query_as(
    "DELETE FROM sso_flows WHERE handoff_hash=$1 AND binding_hash=$2 AND handoff_expires_at > $3 AND purpose='login' RETURNING user_id,redirect_to",
  )
  .bind(handoff_hash)
  .bind(binding_hash)
  .bind(now)
  .fetch_optional(conn)
  .await
}

pub async fn delete_flow(
  conn: &mut SqliteConnection,
  id: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("DELETE FROM sso_flows WHERE id=$1")
    .bind(id)
    .execute(conn)
    .await?;
  Ok(())
}

/// The email and role of an account.
pub async fn account(
  conn: &mut SqliteConnection,
  admin_id: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
  sqlx::query_as(concat!(
    "SELECT u.email, ",
    crate::legacy_role_sql!("a"),
    " FROM users u JOIN accounts a ON a.id = u.id WHERE u.id = $1"
  ))
  .bind(admin_id)
  .fetch_optional(conn)
  .await
}

/// The ID and role of the account with this email.
pub async fn account_by_email(
  conn: &mut SqliteConnection,
  email: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
  sqlx::query_as(concat!(
    "SELECT u.id, ",
    crate::legacy_role_sql!("a"),
    " FROM users u JOIN accounts a ON a.id = u.id WHERE lower(u.email) = lower($1)"
  ))
  .bind(email)
  .fetch_optional(conn)
  .await
}

pub async fn password_hash(
  pool: &SqlitePool,
  admin_id: &str,
) -> Result<Option<String>, sqlx::Error> {
  sqlx::query_scalar("SELECT COALESCE(password_hash, '') FROM users WHERE id = $1")
    .bind(admin_id)
    .fetch_optional(pool)
    .await
}

/// The email and role of the account behind a session that is still live.
pub async fn live_session_account(
  conn: &mut SqliteConnection,
  session_id: Option<&str>,
  admin_id: &str,
  now: &str,
) -> Result<Option<(String, String)>, sqlx::Error> {
  sqlx::query_as(
    concat!(
      "SELECT u.email, ",
      crate::legacy_role_sql!("a"),
      " FROM sessions s JOIN users u ON u.id = s.user_id JOIN accounts a ON a.id = u.id WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.idle_expires_at > $3"
    ),
  )
  .bind(session_id)
  .bind(admin_id)
  .bind(now)
  .fetch_optional(conn)
  .await
}

pub async fn mark_recent_auth(
  conn: &mut SqliteConnection,
  session_id: Option<&str>,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE sessions SET recent_auth_at=$1 WHERE id=$2")
    .bind(now)
    .bind(session_id)
    .execute(conn)
    .await?;
  Ok(())
}
