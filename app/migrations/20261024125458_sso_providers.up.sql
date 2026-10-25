-- The OpenID Connect provider root configures for single sign-on. Version 1
-- allows one row, enforced by the application, but the table is keyed so more
-- providers can follow. The client secret is encrypted with the master key.
-- `verified_at` records the root test sign-in that must succeed before the
-- provider can be enabled; changing the issuer or client clears it.
-- `preset` is an ID from app/src/modules/sso/presets.toml. The server checks
-- it, so adding a preset needs no migration.
CREATE TABLE sso_providers (
  id TEXT PRIMARY KEY,
  preset TEXT NOT NULL,
  display_name TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_ciphertext BLOB NOT NULL,
  client_secret_nonce BLOB NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
