-- Signed owner operations (plan step 11; BR-09, BR-17; invariant B3; apps/api/src/auth.ts, owner.ts).
-- The one-time use of each nonce: the only thing the backend keeps about a signature (no session, token or key, and
-- no issued nonces: those are MACed, not stored). A row is written only after the signature, the nonce's MAC and
-- window and the owner were checked, so unauthenticated requests write nothing here. It matters only while the signed
-- message is inside its window (expires_at = issued + 300 s); the Cron sweep deletes every row past it.
CREATE TABLE used_nonces (
  nonce TEXT PRIMARY KEY CHECK (length(nonce) = 108),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX used_nonces_by_expiry ON used_nonces (expires_at);
-- Owner extensions of a commitment's hosting (12 months each, at most 2: base + 36 months, PD4), kept with its first
-- hosting time, so a deletion and a later upload keep them like they keep the base time.
ALTER TABLE first_hosting ADD COLUMN extensions INTEGER NOT NULL DEFAULT 0 CHECK (extensions BETWEEN 0 AND 2);
