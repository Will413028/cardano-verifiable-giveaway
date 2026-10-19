-- Deleting hosted bytes safely (plan step 10 review M2; apps/api/src/bundles.ts `collect`, `reconcile`).
-- R2 has no conditional delete, so "no record names these bytes" (checked in D1) and "delete the object" (in R2) are two
-- steps a concurrent upload could slip between. A row here claims a bundle hash for deletion: it is inserted only while
-- no hosted record names the hash, and no hosted record is inserted while it exists, so as long as the row is there
-- the bytes are nobody's and may be deleted. `token` names the request holding the claim; `since` lets the Cron
-- reconciliation finish a claim whose holder stopped before releasing it.
CREATE TABLE collecting (
  bundle_hash TEXT PRIMARY KEY CHECK (length(bundle_hash) = 64),
  token TEXT NOT NULL,
  since INTEGER NOT NULL
) STRICT;
-- Where the Cron reconciliation's scan of the R2 objects resumes (the last key it examined; '' starts from the
-- beginning). One row.
CREATE TABLE reconcile_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after TEXT NOT NULL
) STRICT;
INSERT INTO reconcile_cursor (id, after) VALUES (1, '');
