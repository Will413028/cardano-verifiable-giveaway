-- Signed owner operations (plan step 11; BR-09, BR-17; invariant B3; apps/api/src/auth.ts, owner.ts).
-- The nonces this backend issued (GET /nonce) and when: the only thing it keeps about a signature (no session, token
-- or key, nothing about the client). A signed message is accepted only with a nonce listed here at the issue time it
-- names, within 5 minutes of it, and using it deletes the row (one-time). The Cron sweep deletes rows past that
-- window, when the time check refuses their messages anyway.
CREATE TABLE nonces (
  nonce TEXT PRIMARY KEY CHECK (length(nonce) = 32),
  issued_at INTEGER NOT NULL
) STRICT;
CREATE INDEX nonces_by_issue ON nonces (issued_at);
-- Owner extensions of a commitment's hosting (12 months each, at most 2: base + 36 months, PD4), kept with its first
-- hosting time, so a deletion and a later upload keep them like they keep the base time.
ALTER TABLE first_hosting ADD COLUMN extensions INTEGER NOT NULL DEFAULT 0 CHECK (extensions BETWEEN 0 AND 2);
