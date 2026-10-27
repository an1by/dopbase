-- When this instance started chaining audit records. Records without a chain
-- position that are older than this are legacy: they predate the chain and
-- are reported, not sealed. Any later record without a position is suspect.
CREATE TABLE audit_chain_genesis (
  id TEXT PRIMARY KEY CHECK (id = 'chain'),
  started_at TEXT NOT NULL
);

INSERT INTO audit_chain_genesis(id, started_at)
VALUES ('chain', strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'));

-- Sealed records never change. This guards against application bugs; anyone
-- with write access to the database file can drop it, which is what the
-- hash chain is for.
CREATE TRIGGER audit_events_sealed_immutable
BEFORE UPDATE ON audit_events
WHEN OLD.seq IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'sealed audit records are immutable');
END;
