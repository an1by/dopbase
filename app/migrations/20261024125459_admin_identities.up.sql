-- Provider identities linked to Dopbase accounts. After the first link a
-- sign-in is matched on (issuer, subject) only, never on email again, so a
-- changed email at the provider cannot move the identity to another account.
CREATE TABLE admin_identities (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL REFERENCES sso_providers(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email_at_link TEXT,
  linked_via TEXT NOT NULL CHECK (linked_via IN ('auto', 'manual')),
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  UNIQUE (issuer, subject),
  UNIQUE (admin_id, provider_id)
);
