-- Bundle hosting (plan step 10; ADR 2026-10-18-wallet-auth-and-bounded-retention, Amendment 2; invariant B4).
-- A record per commitment transaction: its owner is the organizer identity read from that transaction (the stake
-- address, PD3/PD10), its bytes are the R2 object bundles/<bundle_hash>, shared by every record with that hash and
-- deleted with the last of them (apps/api/src/bundles.ts). expires_at is checked on every read and swept by Cron.
CREATE TABLE hosted (
  tx_hash TEXT PRIMARY KEY CHECK (length(tx_hash) = 64),
  bundle_hash TEXT NOT NULL CHECK (length(bundle_hash) = 64),
  owner TEXT NOT NULL CHECK (owner LIKE 'stake_test1%'),
  round INTEGER NOT NULL,
  hosted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX hosted_by_bundle ON hosted (bundle_hash);
CREATE INDEX hosted_by_owner ON hosted (owner, expires_at);
CREATE INDEX hosted_by_expiry ON hosted (expires_at);
-- Operator takedowns, keyed by the bytes: no record may name a bundle hash listed here.
CREATE TABLE tombstones (
  bundle_hash TEXT PRIMARY KEY CHECK (length(bundle_hash) = 64),
  removed_at INTEGER NOT NULL
) STRICT;
