-- Server drafts (plan step 12; BR-12, BR-18; invariants B3, B5; apps/api/src/drafts.ts). One row per draft: the
-- record lives in D1, the content in R2 (`object_key`), because a draft may be as large as the protocol's bundle limit
-- and a D1 row is limited to 2 MB. Necessity condition: the quota per identity (5) and the 30-day expiry need a record
-- that one statement can count and compare atomically; R2 alone has neither a conditional count nor a query by owner.
-- `owner` is the identity that signed (the preprod reward address of the wallet's stake key, hex; PD4 Amendment), so
-- the same draft id under another identity is another draft. Nothing about the signer is stored but that address.
CREATE TABLE drafts (
  owner TEXT NOT NULL CHECK (length(owner) = 58),
  id TEXT NOT NULL CHECK (length(id) = 32),
  -- drafts/<saved_at, 12 digits>/<random>: a new key per save, so a save never overwrites bytes another request reads,
  -- and the Cron can delete bytes by the save time in their key alone (apps/api/src/drafts.ts `sweepDrafts`).
  object_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  size INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  -- saved_at + 30 days (B5): reads refuse the draft from then on, the Cron deletes the row and the bytes.
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
) STRICT;
CREATE INDEX drafts_by_expiry ON drafts (expires_at);
