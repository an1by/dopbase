-- Adds the `reauth` purpose: confirming a signed-in user again at the
-- identity provider before a sensitive action, for accounts without a
-- password. Also records the client address, so one client cannot fill the
-- table and block everyone else's sign-ins. Rows live for minutes, so the
-- table is recreated rather than rebuilt; a sign-in in progress during the
-- upgrade has to start again.
DROP TABLE sso_flows;

CREATE TABLE sso_flows (
  id TEXT PRIMARY KEY,
  state_hash BLOB NOT NULL UNIQUE,
  provider_id TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'link', 'reauth')),
  nonce TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  binding_hash BLOB NOT NULL,
  session_id TEXT,
  admin_id TEXT REFERENCES admins(id) ON DELETE CASCADE,
  redirect_to TEXT,
  client_ip TEXT,
  consumed_at TEXT,
  handoff_hash BLOB UNIQUE,
  handoff_expires_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX sso_flows_expires_idx ON sso_flows(expires_at);
