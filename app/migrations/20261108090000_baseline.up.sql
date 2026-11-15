-- Dopbase 0.2.0 baseline. One migration holds the whole schema; it
-- replaced the 35 incremental migrations of 0.1.x, which now live in
-- migrations-legacy/ and only run when `dopbase restore` upgrades a 0.1.x
-- backup.
--
-- Rules every table follows:
--  * STRICT, with only TEXT, INTEGER and BLOB columns.
--  * Timestamps are TEXT in one shape, UTC with milliseconds and Z:
--    2026-11-07T09:30:00.000Z (24 characters), written by
--    utils::time. Text order is then time order. No timestamp defaults.
--  * Booleans are INTEGER NOT NULL CHECK (x IN (0, 1)).
--  * Every column that names another row is a FOREIGN KEY, and every
--    foreign-key column leads an index, so a cascade never scans a table.
--    The audit log's actor/project/resource columns are the exception, on
--    purpose: the log outlives what it names.
--  * No triggers stand in for foreign keys. The one trigger left guards
--    sealed audit records against UPDATE.
--  * A NULL scope means "all projects", so scope columns cascade and are
--    never ON DELETE SET NULL: a deleted project must never widen a grant.

------------------------------------------------------------------------
-- Instance
------------------------------------------------------------------------

CREATE TABLE instance_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  verification_ciphertext BLOB NOT NULL,
  verification_nonce BLOB NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

------------------------------------------------------------------------
-- Roles and accounts
------------------------------------------------------------------------

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  max_level TEXT NOT NULL
    CHECK (max_level IN ('metadata', 'read', 'write', 'manage', 'project_manager')),
  sign_in TEXT NOT NULL DEFAULT 'interactive'
    CHECK (sign_in IN ('interactive', 'token_only')),
  requires_owner INTEGER NOT NULL DEFAULT 0 CHECK (requires_owner IN (0, 1)),
  token_scope TEXT NOT NULL DEFAULT 'data'
    CHECK (token_scope IN ('none', 'data', 'audit')),
  token_max_level TEXT NOT NULL DEFAULT 'write'
    CHECK (token_max_level IN ('metadata', 'read', 'write')),
  token_default_ttl_days INTEGER NOT NULL DEFAULT 30
    CHECK (token_default_ttl_days BETWEEN 1 AND 1095),
  token_max_ttl_days INTEGER NOT NULL DEFAULT 365
    CHECK (token_max_ttl_days BETWEEN 1 AND 1095),
  rank INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (token_default_ttl_days <= token_max_ttl_days)
) STRICT;

-- Case-insensitive names without COLLATE NOCASE, which Postgres lacks.
-- Lookups write WHERE lower(name) = lower($1) and use this index.
CREATE UNIQUE INDEX roles_name_uq ON roles (lower(name));

-- Capability names stay free text on purpose: the list lives in
-- services/authx.rs and unknown names are ignored when a role loads, so
-- adding a capability needs no migration.
CREATE TABLE role_capabilities (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  PRIMARY KEY (role_id, capability)
) STRICT;

-- Every account: root, people and AI agents. Each has one row here and one
-- row with the same id in `users` (a person) or `agents` (an AI agent).
-- What both kinds own (grants, group memberships, personal tokens) points
-- here; what only people have (sessions, SSO links, passcodes) points at
-- `users`. The API's `role` field is computed from is_root and kind.
--
-- Every account row is written together with its child row in one
-- transaction (modules/accounts). SQLite can't require the child without a
-- trigger, so the Status page reports an account that has none.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'agent')),
  is_root INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0, 1)),
  -- Root holds no role; everyone else holds exactly one. A role in use
  -- can't be deleted. An agent's role signs in with tokens only; the
  -- service checks that, since the role row can't be reached from here.
  role_id TEXT REFERENCES roles(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Who turned the account off. An owner may turn their AI agent back on
  -- only when they were the one who turned it off.
  disabled_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Target of the (id, kind) keys in users and agents, which keep a child
  -- row on an account of its own kind.
  UNIQUE (id, kind),
  CHECK ((is_root = 1) = (role_id IS NULL)),
  CHECK (is_root = 0 OR (kind = 'user' AND status = 'active')),
  CHECK (status = 'disabled' OR disabled_by IS NULL)
) STRICT;

-- Exactly one root.
CREATE UNIQUE INDEX accounts_root_uq ON accounts (is_root) WHERE is_root = 1;
CREATE INDEX accounts_role_idx ON accounts (role_id);
CREATE INDEX accounts_created_by_idx ON accounts (created_by);
CREATE INDEX accounts_disabled_by_idx ON accounts (disabled_by);

-- Was `admins`. People, root included. Only people sign in.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind = 'user'),
  email TEXT NOT NULL,
  -- NULL for people who sign in with single sign-on only.
  password_hash TEXT,
  last_sign_in_at TEXT,
  FOREIGN KEY (id, kind) REFERENCES accounts (id, kind) ON DELETE CASCADE,
  CHECK (password_hash IS NULL OR password_hash <> '')
) STRICT;

CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

-- AI agents: accounts that sign in with personal tokens only and always
-- have a person who answers for them.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind = 'agent'),
  name TEXT NOT NULL,
  -- An owner is a person, and can't be deleted while they own agents.
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (id, kind) REFERENCES accounts (id, kind) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX agents_name_uq ON agents (lower(name));
CREATE INDEX agents_owner_idx ON agents (owner_id);

-- Every account with its person or AI agent details, for reading. `label`
-- is a person's email or an agent's name. An account that has lost its
-- `users` or `agents` row is left out, so one bad row can't break a list or
-- a sign-in; the Status page reports it instead.
CREATE VIEW account_profiles AS
  SELECT a.id, a.kind, a.is_root, a.role_id, a.status, a.disabled_by,
         a.created_by, a.created_at, a.updated_at,
         COALESCE(u.email, g.name) AS label,
         u.email, u.password_hash, u.last_sign_in_at, g.owner_id
    FROM accounts a
    LEFT JOIN users u ON u.id = a.id
    LEFT JOIN agents g ON g.id = a.id
   WHERE u.id IS NOT NULL OR g.id IS NOT NULL;

------------------------------------------------------------------------
-- Sign-in
------------------------------------------------------------------------

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('browser', 'cli')),
  token_hash BLOB NOT NULL UNIQUE,
  csrf_hash BLOB,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  recent_auth_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  -- auth/service.rs:202 issues a CSRF token for browser sessions only.
  CHECK ((kind = 'browser') = (csrf_hash IS NOT NULL)),
  -- The idle deadline never passes the absolute one (extractors/mod.rs:122
  -- clamps it), so "idle not passed" alone means "live".
  CHECK (idle_expires_at <= absolute_expires_at)
) STRICT;

CREATE INDEX sessions_user_idx ON sessions (user_id);
-- Pruning: revoked_at < cutoff OR idle_expires_at < cutoff. The
-- absolute-expiry index is not needed, given the CHECK above.
CREATE INDEX sessions_revoked_idx ON sessions (revoked_at);
CREATE INDEX sessions_idle_idx ON sessions (idle_expires_at);

CREATE TABLE sso_providers (
  id TEXT PRIMARY KEY,
  -- An id from modules/sso/presets.toml, checked by the server.
  preset TEXT NOT NULL,
  display_name TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_ciphertext BLOB NOT NULL,
  client_secret_nonce BLOB NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  require_sso INTEGER NOT NULL DEFAULT 0 CHECK (require_sso IN (0, 1)),
  hide_password_form INTEGER NOT NULL DEFAULT 0 CHECK (hide_password_form IN (0, 1)),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (enabled = 0 OR verified_at IS NOT NULL),
  CHECK (require_sso = 0 OR enabled = 1)
) STRICT;

-- Was `admin_identities`.
CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email_at_link TEXT,
  linked_via TEXT NOT NULL CHECK (linked_via IN ('auto', 'manual')),
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE (issuer, subject),
  UNIQUE (user_id, provider_id)
) STRICT;

CREATE INDEX user_identities_provider_idx ON user_identities (provider_id);

CREATE TABLE sso_flows (
  id TEXT PRIMARY KEY,
  state_hash BLOB NOT NULL UNIQUE,
  provider_id TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'link', 'reauth')),
  nonce TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  binding_hash BLOB NOT NULL,
  -- Now a foreign key, like cli_device_requests.target_session_id.
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  redirect_to TEXT,
  client_ip TEXT,
  consumed_at TEXT,
  handoff_hash BLOB UNIQUE,
  handoff_expires_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- sso/service.rs:647,678 start link and reauth flows from a session.
  CHECK (purpose = 'login' OR (session_id IS NOT NULL AND user_id IS NOT NULL)),
  CHECK ((handoff_hash IS NULL) = (handoff_expires_at IS NULL))
) STRICT;

CREATE INDEX sso_flows_expires_idx ON sso_flows (expires_at);
CREATE INDEX sso_flows_provider_idx ON sso_flows (provider_id);
CREATE INDEX sso_flows_session_idx ON sso_flows (session_id);
CREATE INDEX sso_flows_user_idx ON sso_flows (user_id);

CREATE TABLE cli_device_requests (
  id TEXT PRIMARY KEY,
  device_code_hash BLOB NOT NULL UNIQUE,
  user_code_hash BLOB NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'consumed')),
  purpose TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'reauth')),
  target_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  client_hostname TEXT,
  client_name TEXT,
  client_ip TEXT,
  approved_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_polled_at TEXT,
  decided_at TEXT,
  -- auth/device.rs:156 sets purpose from whether a session is named.
  CHECK ((purpose = 'reauth') = (target_session_id IS NOT NULL)),
  CHECK (status NOT IN ('approved', 'consumed') OR approved_by IS NOT NULL)
) STRICT;

CREATE INDEX cli_device_requests_expires_idx ON cli_device_requests (expires_at);
CREATE INDEX cli_device_requests_session_idx ON cli_device_requests (target_session_id);
CREATE INDEX cli_device_requests_approver_idx ON cli_device_requests (approved_by);

CREATE TABLE passcodes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The server keeps the list of purposes (services/passcodes.rs).
  purpose TEXT NOT NULL,
  code_hash BLOB NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  -- Was `issued_by`. It holds the host the code was issued on
  -- (cli/commands/admin/handler.rs:176), not an account.
  issued_on TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- user_id first, so the key also serves the cascade from users.
  UNIQUE (user_id, purpose)
) STRICT;

CREATE INDEX passcodes_expires_idx ON passcodes (expires_at);

------------------------------------------------------------------------
-- Projects, environments, secrets
------------------------------------------------------------------------

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1)),
  -- Was the one-to-one table environment_env_layout.
  env_layout TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name),
  -- Target of the (environment_id, project_id) keys in grants and
  -- personal_tokens, which keeps an environment scope inside its project.
  UNIQUE (id, project_id)
) STRICT;

-- One row per key: which version is current. The ciphertext lives only in
-- secret_versions, so re-keying touches one table and the two can't drift.
CREATE TABLE secrets (
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  -- When the key was first created; kept across versions.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (environment_id, key),
  -- The two tables point at each other, so this side is checked at commit.
  -- Postgres: add it with ALTER TABLE after secret_versions exists.
  FOREIGN KEY (environment_id, key, current_version)
    REFERENCES secret_versions (environment_id, key, version)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE secret_versions (
  environment_id TEXT NOT NULL,
  key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  ciphertext BLOB,
  value_nonce BLOB,
  wrapped_key BLOB,
  key_nonce BLOB,
  -- Never read or written by code today; kept for crypto agility.
  encryption_version INTEGER NOT NULL DEFAULT 1,
  change_type TEXT NOT NULL
    CHECK (change_type IN ('legacy', 'created', 'updated', 'imported', 'rolled_back')),
  source_version INTEGER,
  -- Copied, not linked: history outlives the account that wrote it.
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_label TEXT,
  created_at TEXT NOT NULL,
  expired_at TEXT,
  PRIMARY KEY (environment_id, key, version),
  FOREIGN KEY (environment_id, key)
    REFERENCES secrets (environment_id, key) ON DELETE CASCADE,
  CHECK (source_version IS NULL OR source_version < version),
  CHECK (
    (expired_at IS NULL AND ciphertext IS NOT NULL AND value_nonce IS NOT NULL
      AND wrapped_key IS NOT NULL AND key_nonce IS NOT NULL)
    OR (expired_at IS NOT NULL AND ciphertext IS NULL AND value_nonce IS NULL
      AND wrapped_key IS NULL AND key_nonce IS NULL)
  )
) STRICT;

------------------------------------------------------------------------
-- Tokens
------------------------------------------------------------------------

CREATE TABLE runner_tokens (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash BLOB NOT NULL UNIQUE,
  -- The person who made the token. Deleting them deletes it, and it stops
  -- working while they are disabled. NULL only for tokens brought over from
  -- 0.1.x, which didn't record a creator.
  created_by TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  UNIQUE (environment_id, name)
) STRICT;

CREATE INDEX runner_tokens_created_by_idx ON runner_tokens (created_by);

CREATE TABLE personal_tokens (
  id TEXT PRIMARY KEY,
  -- A person's or an AI agent's.
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash BLOB NOT NULL UNIQUE,
  -- all and audit name nothing; project names project_id; environment
  -- names both, and the pair must be a real environment of that project.
  scope TEXT NOT NULL CHECK (scope IN ('all', 'project', 'environment', 'audit')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  environment_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('none', 'metadata', 'read', 'write')),
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  -- Personal tokens always expire (tokens/personal/service.rs:201).
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  UNIQUE (account_id, name),
  FOREIGN KEY (environment_id, project_id)
    REFERENCES environments (id, project_id) ON DELETE CASCADE,
  CHECK ((scope IN ('project', 'environment')) = (project_id IS NOT NULL)),
  CHECK ((scope = 'environment') = (environment_id IS NOT NULL)),
  CHECK ((scope = 'audit') = (level = 'none'))
) STRICT;

CREATE INDEX personal_tokens_project_idx ON personal_tokens (project_id);
CREATE INDEX personal_tokens_environment_idx ON personal_tokens (environment_id, project_id);
CREATE INDEX personal_tokens_created_by_idx ON personal_tokens (created_by);

------------------------------------------------------------------------
-- Groups and grants
------------------------------------------------------------------------

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX groups_name_uq ON groups (lower(name));
CREATE INDEX groups_created_by_idx ON groups (created_by);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  -- A person or an AI agent.
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  added_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, account_id)
) STRICT;

CREATE INDEX group_members_account_idx ON group_members (account_id);
CREATE INDEX group_members_added_by_idx ON group_members (added_by);

-- A level for one account (a person or an AI agent) or one group, on all
-- projects, one project, or one environment. Exactly one of
-- account_id/group_id is set. `scope` is stored,
-- not derived, so that a NULL project_id can only mean "all projects" when
-- the row says so: a stray UPDATE that clears project_id fails a CHECK
-- instead of widening the grant.
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('all', 'project', 'environment')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  -- Environment grants keep their project too, so "grants on a project and
  -- its environments" is WHERE project_id = $1.
  environment_id TEXT,
  level TEXT NOT NULL
    CHECK (level IN ('none', 'metadata', 'read', 'write', 'manage', 'project_manager')),
  granted_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  -- Today's upsert overwrites created_at (grants/repository.rs:161);
  -- a change now moves updated_at only.
  updated_at TEXT NOT NULL,
  FOREIGN KEY (environment_id, project_id)
    REFERENCES environments (id, project_id) ON DELETE CASCADE,
  CHECK ((account_id IS NULL) <> (group_id IS NULL)),
  CHECK ((scope = 'all') = (project_id IS NULL)),
  CHECK ((scope = 'environment') = (environment_id IS NOT NULL)),
  CHECK (scope <> 'environment' OR level <> 'project_manager'),
  CHECK (scope = 'environment' OR level <> 'none')
) STRICT;

-- One grant per principal and scope. NULLs never collide in a unique
-- index (SQLite and Postgres agree), which does most of the work: a
-- group's row has account_id NULL and can't clash with an account's, and only
-- environment grants have an environment_id. The four partial indexes
-- cover the scopes whose key would otherwise be NULL or shared.
CREATE UNIQUE INDEX grants_account_all_uq ON grants (account_id) WHERE scope = 'all';
CREATE UNIQUE INDEX grants_group_all_uq ON grants (group_id) WHERE scope = 'all';
CREATE UNIQUE INDEX grants_account_project_uq ON grants (account_id, project_id) WHERE scope = 'project';
CREATE UNIQUE INDEX grants_group_project_uq ON grants (group_id, project_id) WHERE scope = 'project';
-- Plain, not partial: these also serve as the account_id and group_id
-- foreign-key indexes, which a partial index can't.
CREATE UNIQUE INDEX grants_account_environment_uq ON grants (account_id, environment_id);
CREATE UNIQUE INDEX grants_group_environment_uq ON grants (group_id, environment_id);
CREATE INDEX grants_project_idx ON grants (project_id);
CREATE INDEX grants_environment_idx ON grants (environment_id, project_id);
CREATE INDEX grants_granted_by_idx ON grants (granted_by);

------------------------------------------------------------------------
-- Audit
------------------------------------------------------------------------

-- Every record is chained: there are no pre-chain records in a 0.2.0
-- database (the restore upgrade archives them), so audit_chain_genesis is
-- gone.
-- created_at and metadata are hashed as stored text (audit_chain.rs:139),
-- so neither may be normalised or re-encoded: Postgres keeps them as text,
-- not timestamptz or jsonb, and imported records keep their old
-- timestamp shape.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_label TEXT,
  action TEXT NOT NULL,
  project_id TEXT,
  environment_id TEXT,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  prev_hash TEXT,
  record_hash TEXT NOT NULL,
  -- audit_chain.rs:228: only the first record has no predecessor.
  CHECK ((seq = 1) = (prev_hash IS NULL))
) STRICT;

CREATE INDEX audit_events_created_idx ON audit_events (created_at, id);
CREATE INDEX audit_events_action_idx ON audit_events (action, created_at);
-- The audit page's filters. They only help once the query adds a filter
-- when it is set, instead of (? IS NULL OR project_id = ?).
CREATE INDEX audit_events_project_idx ON audit_events (project_id, created_at, id);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, created_at, id);

-- Where verification picks the chain up after retention pruned it.
CREATE TABLE audit_chain_anchor (
  id TEXT PRIMARY KEY CHECK (id = 'chain'),
  pruned_seq INTEGER NOT NULL,
  pruned_hash TEXT NOT NULL,
  pruned_at TEXT NOT NULL
) STRICT;

-- A guard against application bugs, not a stand-in for a foreign key.
-- Postgres: a BEFORE UPDATE trigger function, or REVOKE UPDATE.
CREATE TRIGGER audit_events_sealed_immutable
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'sealed audit records are immutable');
END;

------------------------------------------------------------------------
-- Built-in roles. A literal timestamp, since the baseline can't call a
-- clock portably.
------------------------------------------------------------------------

INSERT INTO roles (id, name, description, builtin, max_level, sign_in, requires_owner,
  token_scope, token_max_level, token_default_ttl_days, token_max_ttl_days, rank,
  created_at, updated_at) VALUES
  ('rol_admin', 'Admin', 'Manages people, groups, and the projects they are given.',
    1, 'project_manager', 'interactive', 0, 'data', 'write', 30, 365, 10,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('rol_member', 'Member', 'Works on the projects and environments they are given.',
    1, 'manage', 'interactive', 0, 'data', 'write', 30, 365, 20,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('rol_auditor', 'Auditor', 'Reads the audit log and access reports. Never sees secret values.',
    1, 'metadata', 'interactive', 0, 'audit', 'metadata', 30, 365, 30,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('rol_ai_agent', 'AI agent', 'Signs in with tokens only and never exceeds its owner.',
    1, 'write', 'token_only', 1, 'data', 'write', 30, 90, 40,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

INSERT INTO role_capabilities (role_id, capability) VALUES
  ('rol_admin', 'users.view'), ('rol_admin', 'users.manage'), ('rol_admin', 'groups.manage'),
  ('rol_admin', 'grants.manage'), ('rol_admin', 'projects.create'), ('rol_admin', 'audit.read'),
  ('rol_admin', 'audit.verify'), ('rol_admin', 'instance.view'), ('rol_admin', 'access.report'),
  ('rol_admin', 'tokens.personal'), ('rol_admin', 'tokens.revoke_others'),
  ('rol_admin', 'agents.view'), ('rol_admin', 'agents.view_all'), ('rol_admin', 'agents.manage'),
  ('rol_member', 'tokens.personal'), ('rol_member', 'agents.view'),
  ('rol_auditor', 'users.view'), ('rol_auditor', 'audit.read'), ('rol_auditor', 'audit.read_all'),
  ('rol_auditor', 'audit.verify'), ('rol_auditor', 'access.report'),
  ('rol_auditor', 'instance.view'), ('rol_auditor', 'agents.view_all'),
  ('rol_auditor', 'tokens.personal'),
  ('rol_ai_agent', 'tokens.personal');
