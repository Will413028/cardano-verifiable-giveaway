-- The first time each commitment was hosted (plan step 10b; ADR 2026-10-18-wallet-auth-and-bounded-retention,
-- Amendment 5). Retention counts from min(round time, first hosting time); this row outlives the hosted record (expiry,
-- owner deletion, takedown), so uploading the same commitment again cannot start a new 12 months before its round.
-- keep_until = 12 months after the round time: from then on the round time alone ends any hosting period, so the
-- Cron sweep deletes the row; NULL when the round lies too far ahead for a date (such a row is kept).
CREATE TABLE first_hosting (
  tx_hash TEXT PRIMARY KEY CHECK (length(tx_hash) = 64),
  first_hosted_at INTEGER NOT NULL,
  keep_until INTEGER
) STRICT;
CREATE INDEX first_hosting_by_keep ON first_hosting (keep_until);
