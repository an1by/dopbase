-- Pending browser approvals for `dopbase login --browser`. The CLI holds the
-- device code and polls with it; the user types or follows the user code in
-- the Admin UI. Only hashes of both codes are stored, and a row is single-use:
-- once its session is issued it moves to `consumed`.
CREATE TABLE cli_device_requests (
  id TEXT PRIMARY KEY,
  device_code_hash BLOB NOT NULL UNIQUE,
  user_code_hash BLOB NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'consumed')),
  client_hostname TEXT,
  client_ip TEXT,
  approved_by TEXT REFERENCES admins(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_polled_at TEXT,
  decided_at TEXT
);

CREATE INDEX cli_device_requests_expires_idx ON cli_device_requests(expires_at);
