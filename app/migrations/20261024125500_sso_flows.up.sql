-- In-progress sign-ins with the provider. A row holds the PKCE verifier and
-- nonce between the redirect and the callback, and is bound to the browser
-- that started it. The callback consumes it once; a successful login then
-- leaves a short-lived handoff code that the Admin UI exchanges for a
-- session, and the exchange deletes the row.
CREATE TABLE sso_flows (
  id TEXT PRIMARY KEY,
  state_hash BLOB NOT NULL UNIQUE,
  provider_id TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'link')),
  nonce TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  binding_hash BLOB NOT NULL,
  session_id TEXT,
  admin_id TEXT REFERENCES admins(id) ON DELETE CASCADE,
  redirect_to TEXT,
  consumed_at TEXT,
  handoff_hash BLOB UNIQUE,
  handoff_expires_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX sso_flows_expires_idx ON sso_flows(expires_at);
