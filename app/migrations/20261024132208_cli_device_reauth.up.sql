-- Lets a browser approval confirm an existing CLI session instead of
-- issuing a new one: `purpose = 'reauth'` names the session in
-- `target_session_id`. This is how accounts without a password confirm
-- plaintext secret access from the CLI. Rows expire within minutes, so the
-- table is recreated; a login waiting during the upgrade has to start again.
DROP TABLE cli_device_requests;

CREATE TABLE cli_device_requests (
  id TEXT PRIMARY KEY,
  device_code_hash BLOB NOT NULL UNIQUE,
  user_code_hash BLOB NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'consumed')),
  purpose TEXT NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'reauth')),
  target_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  client_hostname TEXT,
  client_ip TEXT,
  approved_by TEXT REFERENCES admins(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_polled_at TEXT,
  decided_at TEXT
);

CREATE INDEX cli_device_requests_expires_idx ON cli_device_requests(expires_at);
