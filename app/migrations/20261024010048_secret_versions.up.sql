-- One row per stored version of a secret, the current one included. Rows
-- older than the retention count keep their metadata but lose their
-- ciphertext and get an expired_at time.
CREATE TABLE secret_versions (
  environment_id TEXT NOT NULL,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  ciphertext BLOB,
  value_nonce BLOB,
  wrapped_key BLOB,
  key_nonce BLOB,
  encryption_version INTEGER NOT NULL DEFAULT 1,
  change_type TEXT NOT NULL
    CHECK (change_type IN ('legacy', 'created', 'updated', 'imported', 'rolled_back')),
  source_version INTEGER,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  actor_label TEXT,
  created_at TEXT NOT NULL,
  expired_at TEXT,
  PRIMARY KEY (environment_id, key, version),
  FOREIGN KEY (environment_id, key) REFERENCES secrets(environment_id, key) ON DELETE CASCADE,
  CHECK (
    (expired_at IS NULL AND ciphertext IS NOT NULL AND value_nonce IS NOT NULL
      AND wrapped_key IS NOT NULL AND key_nonce IS NOT NULL)
    OR (expired_at IS NOT NULL AND ciphertext IS NULL AND value_nonce IS NULL
      AND wrapped_key IS NULL AND key_nonce IS NULL)
  )
);

-- Secrets written before this version keep their current value as a legacy
-- row. The ciphertext is copied as is: its AAD binds environment, key, and
-- version, which do not change.
INSERT INTO secret_versions (
  environment_id, key, version, ciphertext, value_nonce, wrapped_key, key_nonce,
  encryption_version, change_type, source_version, actor_type, actor_id, actor_label,
  created_at, expired_at
)
SELECT environment_id, key, version, ciphertext, value_nonce, wrapped_key, key_nonce,
  encryption_version, 'legacy', NULL, 'system', NULL, NULL, updated_at, NULL
FROM secrets;
