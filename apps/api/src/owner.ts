import { consumeNonce, requireOwner, verifySigned } from './auth.ts';
import { release, TX_HASH } from './bundles.ts';
import { HttpError } from './http.ts';
import { hostingExpiry, MAX_EXTENSIONS } from './retention.ts';

// Signed owner operations on a hosted bundle (plan step 11; BR-09, BR-13, BR-17; ADR 2026-10-18-wallet-auth-and-
// bounded-retention). The owner is the one recorded with the hosting, read from the commitment transaction when it was
// hosted (`commitmentOwner`); these routes read no chain. Hosting itself is the third signed operation
// (apps/api/src/bundles.ts `upload`).

interface Owned {
  owner: string;
  bundle_hash: string;
}
function requireRecord<T extends Owned>(record: T | null, signed: ReturnType<typeof verifySigned>): T {
  if (!record) throw new HttpError(404, 'No bundle is hosted for this commitment');
  requireOwner(signed, record.owner);
  if (signed.op.bundleHash !== record.bundle_hash)
    throw new HttpError(409, 'The signed message names another bundle than the one hosted for this commitment');
  return record;
}

// DELETE /bundles/{txHash}: the owner removes the hosting record and, when no other record names them, the bytes
// (`release`; B4: only this record, never a tombstone). The first hosting time and extensions stay (ADR Amendment 5):
// hosting the same commitment again keeps its expiry. The page reminds the organizer to keep the downloaded files.
export async function remove(
  env: { DB: D1Database; BUNDLES: R2Bucket },
  request: Request,
  txHash: string,
  now: number,
  domain: string | null,
): Promise<{ txHash: string; deleted: true }> {
  if (!TX_HASH.test(txHash)) throw new HttpError(400, 'Invalid transaction hash');
  const signed = verifySigned(request, { domain, operation: 'delete', txHash }, now);
  requireRecord(
    await env.DB.prepare('SELECT owner, bundle_hash FROM hosted WHERE tx_hash = ?').bind(txHash).first<Owned>(),
    signed,
  );
  await consumeNonce(env.DB, signed.op);
  await release(env, txHash, now);
  return { txHash, deleted: true };
}

// POST /bundles/{txHash}/extend: 12 more months, counted from the base time like the first 12 (retention.ts
// `hostingExpiry`), at most MAX_EXTENSIONS times: base + 36 months (PD4, BR-17). Only a live hosting is extended; an
// ended one stays ended (the period is over, and reviving it would be a new period). The count lives on the
// first_hosting row with the base time, so it outlives a deletion like the base time does.
export async function extend(
  env: { DB: D1Database },
  request: Request,
  txHash: string,
  now: number,
  domain: string | null,
): Promise<{ txHash: string; expiresAt: number; extensionsLeft: number }> {
  if (!TX_HASH.test(txHash)) throw new HttpError(400, 'Invalid transaction hash');
  const signed = verifySigned(request, { domain, operation: 'extend', txHash }, now);
  const record = requireRecord(
    await env.DB.prepare(
      `SELECT h.owner, h.bundle_hash, h.round, h.expires_at, f.first_hosted_at, f.extensions
       FROM hosted h JOIN first_hosting f ON f.tx_hash = h.tx_hash WHERE h.tx_hash = ?`,
    )
      .bind(txHash)
      .first<Owned & { round: number; expires_at: number; first_hosted_at: number; extensions: number }>(),
    signed,
  );
  if (record.expires_at <= now) throw new HttpError(410, 'The hosting period of this bundle has ended');
  if (record.extensions >= MAX_EXTENSIONS)
    throw new HttpError(
      409,
      `Hosting is already extended to its limit: 36 months after the earlier of the round and the first hosting (until ${new Date(record.expires_at * 1000).toISOString()})`,
    );
  const extensions = record.extensions + 1;
  const expiresAt = hostingExpiry(record.round, record.first_hosted_at, extensions);
  await consumeNonce(env.DB, signed.op);
  const results = await env.DB.batch([
    // Conditional on the count read above, so two concurrent extensions cannot both count.
    env.DB.prepare(
      `UPDATE first_hosting SET extensions = ?2,
           keep_until = CASE WHEN keep_until IS NULL THEN NULL ELSE max(keep_until, ?3) END
         WHERE tx_hash = ?1 AND extensions = ?2 - 1`,
    ).bind(txHash, extensions, expiresAt),
    env.DB.prepare(
      'UPDATE hosted SET expires_at = ?2 WHERE tx_hash = ?1 AND (SELECT extensions FROM first_hosting WHERE tx_hash = ?1) = ?3',
    ).bind(txHash, expiresAt, extensions),
  ]);
  if (results[0].meta.changes !== 1)
    throw new HttpError(409, 'The hosting was extended by a concurrent request; retry');
  return { txHash, expiresAt, extensionsLeft: MAX_EXTENSIONS - extensions };
}
