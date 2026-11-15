use sqlx::{SqliteConnection, SqlitePool};

use crate::modules::{accounts::Kind, grants::model::GroupRef};

/// Whether an account takes a spot under the people limit: an active
/// person, never root or an AI agent. `$a` aliases `accounts`, so the count
/// and the users list share one rule.
macro_rules! counts_toward_limit {
  ($a:literal) => {
    concat!(
      "(",
      $a,
      ".is_root = 0 AND ",
      $a,
      ".status = 'active' AND ",
      $a,
      ".kind = 'user')"
    )
  };
}

/// One account of either kind from `account_profiles` as `a`, with its
/// role as `r`.
const ACCOUNT_FROM: &str = "account_profiles a LEFT JOIN roles r ON r.id = a.role_id";

/// People and agents share one row shape inside the module; `label` is a
/// person's email or an agent's name.
const USER_COLUMNS: &str = concat!(
  "a.id,a.label,",
  crate::legacy_role_sql!("a"),
  " AS role,a.role_id,CASE WHEN a.is_root = 1 THEN 'Root' ELSE COALESCE(r.name, '') END AS role_name,a.created_at,a.updated_at,a.password_hash IS NOT NULL AS has_password,EXISTS(SELECT 1 FROM user_identities i WHERE i.user_id=a.id) AS sso_linked,a.owner_id,(SELECT o.email FROM users o WHERE o.id = a.owner_id) AS owner_email,a.kind = 'agent' AS agent,(a.status = 'active' AND a.kind = 'user' AND (a.is_root = 1 OR (r.sign_in = 'interactive' AND EXISTS(SELECT 1 FROM role_capabilities c WHERE c.role_id = a.role_id AND c.capability = 'agents.view')))) AS can_own,a.status,a.last_sign_in_at,",
  counts_toward_limit!("a"),
  " AS counts_toward_limit"
);

#[derive(sqlx::FromRow)]
pub struct UserRow {
  pub id: String,
  /// A person's email or an AI agent's name.
  pub label: String,
  pub role: String,
  pub role_id: Option<String>,
  pub role_name: String,
  pub created_at: String,
  pub updated_at: String,
  pub has_password: bool,
  pub sso_linked: bool,
  pub owner_id: Option<String>,
  pub owner_email: Option<String>,
  /// An AI agent, stored in `agents`.
  pub agent: bool,
  /// An active person who could own an AI agent, as [`can_own`] judges it.
  pub can_own: bool,
  pub status: String,
  pub last_sign_in_at: Option<String>,
  /// Takes a spot under the people limit.
  pub counts_toward_limit: bool,
}

/// The accounts of `kind`: root first, then by role rank, each by email or
/// name.
pub async fn list(
  pool: &SqlitePool,
  kind: Kind,
) -> Result<Vec<UserRow>, sqlx::Error> {
  sqlx::query_as(&format!(
    "SELECT {USER_COLUMNS} FROM {ACCOUNT_FROM} WHERE a.kind = $1 ORDER BY a.is_root DESC, r.rank, a.label"
  ))
  .bind(kind.as_str())
  .fetch_all(pool)
  .await
}

/// Every person's id and email, by email.
pub async fn identities(pool: &SqlitePool) -> Result<Vec<(String, String)>, sqlx::Error> {
  sqlx::query_as("SELECT id, email FROM users ORDER BY email")
    .fetch_all(pool)
    .await
}

/// The account `id` when it is of `kind`.
pub async fn find(
  pool: &SqlitePool,
  id: &str,
  kind: Kind,
) -> Result<Option<UserRow>, sqlx::Error> {
  sqlx::query_as(&format!(
    "SELECT {USER_COLUMNS} FROM {ACCOUNT_FROM} WHERE a.id=$1 AND a.kind=$2"
  ))
  .bind(id)
  .bind(kind.as_str())
  .fetch_optional(pool)
  .await
}

/// Every group membership of the accounts of `kind` as (account id,
/// group), each account's by group name.
pub async fn memberships(
  pool: &SqlitePool,
  kind: Kind,
) -> Result<Vec<(String, GroupRef)>, sqlx::Error> {
  let rows: Vec<(String, String, String)> = sqlx::query_as(
    "SELECT m.account_id, g.id, g.name FROM group_members m JOIN groups g ON g.id = m.group_id JOIN accounts a ON a.id = m.account_id WHERE a.kind = $1 ORDER BY g.name",
  )
  .bind(kind.as_str())
  .fetch_all(pool)
  .await?;
  Ok(
    rows
      .into_iter()
      .map(|(user_id, id, name)| (user_id, GroupRef { id, name }))
      .collect(),
  )
}

/// Active people, the accounts a people limit counts: not root, and not AI
/// agents.
const ACTIVE_PEOPLE: &str = concat!(
  "SELECT COUNT(*) FROM accounts p WHERE ",
  counts_toward_limit!("p")
);

pub async fn active_people(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
  sqlx::query_scalar(ACTIVE_PEOPLE).fetch_one(pool).await
}

/// Sets `status` and returns false when the account already had it, or
/// when `limit` is set and that many people are already active. Root is
/// never disabled. `by` is who turned it off; turning it on clears it.
pub async fn set_status(
  conn: &mut SqliteConnection,
  id: &str,
  status: &str,
  by: &str,
  limit: Option<u32>,
  now: &str,
) -> Result<bool, sqlx::Error> {
  // The count sits in the same statement as the write, so two requests at
  // once can't both take the last spot.
  let query = format!(
    "UPDATE accounts SET status=$1,disabled_by=CASE WHEN $1 = 'disabled' THEN $7 END,updated_at=$2 WHERE id=$3 AND is_root=0 AND status<>$4 AND ($5 IS NULL OR ({ACTIVE_PEOPLE}) < $6)"
  );
  Ok(
    sqlx::query(&query)
      .bind(status)
      .bind(now)
      .bind(id)
      .bind(status)
      .bind(limit)
      .bind(limit)
      .bind(by)
      .execute(conn)
      .await?
      .rows_affected()
      == 1,
  )
}

/// `active` or `disabled`, or `None` when the account doesn't exist.
pub async fn status(
  conn: &mut SqliteConnection,
  id: &str,
) -> Result<Option<String>, sqlx::Error> {
  sqlx::query_scalar("SELECT status FROM accounts WHERE id=$1")
    .bind(id)
    .fetch_optional(conn)
    .await
}

/// What changing an account needs to know about it.
#[derive(sqlx::FromRow)]
pub struct Account {
  /// A person's email or an AI agent's name.
  pub label: String,
  pub is_root: bool,
  pub role_id: Option<String>,
  /// An AI agent, stored in `agents`.
  pub agent: bool,
  pub owner_id: Option<String>,
  /// `active` or `disabled`.
  pub status: String,
}

/// The account `id` when it is of `kind`.
pub async fn account(
  pool: &SqlitePool,
  id: &str,
  kind: Kind,
) -> Result<Option<Account>, sqlx::Error> {
  sqlx::query_as("SELECT label, is_root, role_id, kind = 'agent' AS agent, owner_id, status FROM account_profiles WHERE id = $1 AND kind = $2")
    .bind(id)
    .bind(kind.as_str())
    .fetch_optional(pool)
    .await
}

/// Who turned the account off. `None` while it is on, or when that person
/// has since been deleted.
pub async fn disabled_by(
  pool: &SqlitePool,
  id: &str,
) -> Result<Option<String>, sqlx::Error> {
  let by: Option<Option<String>> =
    sqlx::query_scalar("SELECT disabled_by FROM accounts WHERE id = $1")
      .bind(id)
      .fetch_optional(pool)
      .await?;
  Ok(by.flatten())
}

/// The owner of `id` when it is an AI agent; `None` for a person or a
/// missing account. Every agent has an owner.
pub async fn agent(
  pool: &SqlitePool,
  id: &str,
) -> Result<Option<String>, sqlx::Error> {
  sqlx::query_scalar("SELECT owner_id FROM agents WHERE id = $1")
    .bind(id)
    .fetch_optional(pool)
    .await
}

/// What only one kind of account has.
pub enum NewDetails<'a> {
  Person {
    email: &'a str,
    /// Empty for someone without a password; stored as NULL.
    password_hash: &'a str,
  },
  Agent {
    name: &'a str,
    /// The person who answers for the agent.
    owner_id: &'a str,
  },
}

impl NewDetails<'_> {
  fn kind(&self) -> Kind {
    match self {
      Self::Person { .. } => Kind::User,
      Self::Agent { .. } => Kind::Agent,
    }
  }
}

pub struct NewUser<'a> {
  pub id: &'a str,
  pub details: NewDetails<'a>,
  pub role_id: &'a str,
  pub created_by: &'a str,
  pub now: &'a str,
  /// The people limit to respect, for a person. `None` for AI agents and
  /// when there is no limit.
  pub limit: Option<u32>,
}

/// Adds the `accounts` row and its `users` or `agents` row. Returns false,
/// adding nobody, when `user.limit` is set and that many people are already
/// active. Fails with a unique violation when the email or agent name is
/// taken. Run it inside a transaction, so a failed second write leaves no
/// account behind.
pub async fn insert(
  conn: &mut SqliteConnection,
  user: NewUser<'_>,
) -> Result<bool, sqlx::Error> {
  // The count sits in the same statement as the write, so two requests at
  // once can't both take the last spot.
  let query = format!(
    "INSERT INTO accounts(id,kind,role_id,created_by,created_at,updated_at) SELECT $1,$2,$3,$4,$5,$6 WHERE $7 IS NULL OR ({ACTIVE_PEOPLE}) < $8"
  );
  let added = sqlx::query(&query)
    .bind(user.id)
    .bind(user.details.kind().as_str())
    .bind(user.role_id)
    .bind(user.created_by)
    .bind(user.now)
    .bind(user.now)
    .bind(user.limit)
    .bind(user.limit)
    .execute(&mut *conn)
    .await?
    .rows_affected()
    == 1;
  if !added {
    return Ok(false);
  }
  match user.details {
    NewDetails::Person {
      email,
      password_hash,
    } => {
      sqlx::query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,NULLIF($3, ''))")
        .bind(user.id)
        .bind(email)
        .bind(password_hash)
        .execute(&mut *conn)
        .await?;
    }
    NewDetails::Agent { name, owner_id } => {
      sqlx::query("INSERT INTO agents(id,name,owner_id) VALUES($1,$2,$3)")
        .bind(user.id)
        .bind(name)
        .bind(owner_id)
        .execute(&mut *conn)
        .await?;
    }
  }
  Ok(true)
}

/// Sets a person's email or an agent's name to `email`. Leaves the
/// password unchanged when `password_hash` is `None`, and the role when
/// `role_id` is `None`. An agent has no password. Fails with a unique
/// violation when the email or name is taken.
pub async fn update(
  conn: &mut SqliteConnection,
  id: &str,
  kind: Kind,
  email: &str,
  password_hash: Option<&str>,
  role_id: Option<&str>,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE accounts SET role_id=COALESCE($1,role_id),updated_at=$2 WHERE id=$3")
    .bind(role_id)
    .bind(now)
    .bind(id)
    .execute(&mut *conn)
    .await?;
  match kind {
    Kind::User => {
      sqlx::query(
        "UPDATE users SET email=$1,password_hash=COALESCE(NULLIF($2, ''),password_hash) WHERE id=$3",
      )
      .bind(email)
      .bind(password_hash)
      .bind(id)
      .execute(&mut *conn)
      .await?;
    }
    Kind::Agent => {
      sqlx::query("UPDATE agents SET name=$1 WHERE id=$2")
        .bind(email)
        .bind(id)
        .execute(&mut *conn)
        .await?;
    }
  }
  Ok(())
}

pub async fn revoke_sessions(
  conn: &mut SqliteConnection,
  id: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE sessions SET revoked_at=$1 WHERE user_id=$2 AND revoked_at IS NULL")
    .bind(now)
    .bind(id)
    .execute(conn)
    .await?;
  Ok(())
}

/// Cancels the CLI logins the account approved that the CLI hasn't picked
/// up yet, so none of them turns into a session.
pub async fn cancel_device_approvals(
  conn: &mut SqliteConnection,
  id: &str,
  now: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE cli_device_requests SET status='cancelled',decided_at=$1 WHERE approved_by=$2 AND status='approved'")
    .bind(now)
    .bind(id)
    .execute(conn)
    .await?;
  Ok(())
}

/// Root can never be deleted. Removing the `accounts` row takes its
/// `users` or `agents` row, grants, memberships and tokens with it.
pub async fn delete(
  conn: &mut SqliteConnection,
  id: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("DELETE FROM accounts WHERE id=$1 AND is_root=0")
    .bind(id)
    .execute(conn)
    .await?;
  Ok(())
}

/// How many AI agents this person owns.
pub async fn owned_count(
  pool: &SqlitePool,
  id: &str,
) -> Result<i64, sqlx::Error> {
  sqlx::query_scalar("SELECT COUNT(*) FROM agents WHERE owner_id=$1")
    .bind(id)
    .fetch_one(pool)
    .await
}

/// Whether `id` can own an AI agent: an active person whose role signs in
/// and holds agents.view, so they can see and run it.
pub async fn can_own(
  conn: &mut SqliteConnection,
  id: &str,
) -> Result<bool, sqlx::Error> {
  let found: Option<i64> = sqlx::query_scalar(
    "SELECT 1 FROM accounts a LEFT JOIN roles r ON r.id = a.role_id WHERE a.id = $1 AND a.kind = 'user' AND a.status = 'active' AND (a.is_root = 1 OR (r.sign_in = 'interactive' AND EXISTS(SELECT 1 FROM role_capabilities c WHERE c.role_id = a.role_id AND c.capability = 'agents.view')))",
  )
  .bind(id)
  .fetch_optional(conn)
  .await?;
  Ok(found.is_some())
}

pub async fn set_owner(
  conn: &mut SqliteConnection,
  id: &str,
  owner_id: &str,
) -> Result<(), sqlx::Error> {
  sqlx::query("UPDATE agents SET owner_id=$1 WHERE id=$2")
    .bind(owner_id)
    .bind(id)
    .execute(conn)
    .await?;
  Ok(())
}

/// Whether a role signs in with tokens only, and whether it is built in.
pub async fn role_sign_in(
  pool: &SqlitePool,
  role_id: &str,
) -> Result<Option<(bool, bool)>, sqlx::Error> {
  sqlx::query_as("SELECT sign_in = 'token_only', builtin FROM roles WHERE id = $1")
    .bind(role_id)
    .fetch_optional(pool)
    .await
}
