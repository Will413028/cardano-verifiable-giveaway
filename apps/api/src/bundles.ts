import { type BlockfrostChain, CborPendingError, IndexerError, identityOf, NotIndexedError } from '@giveaway/chain';
import { BUNDLE_BYTE_LIMIT, sha256, validateBundle } from '@giveaway/protocol';
import { hostingExpiry, SWEEP_LIMIT } from './retention.ts';

// Bundle hosting (plan step 10; BR-06, BR-07, BR-08, BR-17; invariant B4; ADR 2026-10-18-wallet-auth-and-bounded-
// retention with Amendment 2). Records live in D1 (migrations/0001_bundle_hosting.sql), bytes in R2.
//
// - A record is keyed by the commitment's txHash and owned by the organizer identity read from that transaction, so
//   anyone committing the same bundle hash in their own transaction gets their own record and cannot take over or
//   block another's (Amendment 2).
// - Bytes are stored once per bundle hash (`bundles/<sha256>`) and shared by every record naming it; they are deleted
//   when the last record goes (reference counting by the records themselves, so no counter can drift).
// - An owner removing a record removes only that record; an operator takedown leaves a tombstone keyed by the bundle
//   hash, after which nobody can host those bytes again.
//
// The gate needs chain evidence the uploader cannot forge, so the backend reads the indexer itself: necessity
// condition — hosting accepts only bytes whose hash an on-chain commitment carries (B4). It uses the verifier's own
// BlockfrostChain reads (commitmentOwner, readCommitment: CBOR hash checks, identity witness, PD10 withdrawal, 15
// confirmations), never a second implementation, and it decides no PASS/FAIL (B2): a hosted bundle is checked again by
// every verifier. Should hosting stop requiring an on-chain commitment, INDEXER_URL has no reason to exist.

export interface HostingEnv {
  DB: D1Database;
  BUNDLES: R2Bucket;
  // The project indexer the gate reads (server-side; not a route of this Worker, BR-01).
  INDEXER_URL?: string;
}
export type HostingChain = Pick<BlockfrostChain, 'commitmentOwner' | 'readCommitment'>;
// Hosted bundles per owner identity at any time (BR-17; PD4 default).
export const OWNER_QUOTA = 20;
export const objectKey = (bundleHash: string) => `bundles/${bundleHash}`;
const TX_HASH = /^[a-f0-9]{64}$/;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Hosted {
  txHash: string;
  bundleHash: string;
  // The stake address of the organizer identity (PD3, PD10): the quota key, and whose stake key will authorize owner
  // operations (plan step 11).
  owner: string;
  expiresAt: number;
}

// The request body, refused as soon as it passes the protocol's canonical bundle limit (BUNDLE_BYTE_LIMIT).
async function readLimited(request: Request): Promise<Uint8Array> {
  const tooLarge = () => new HttpError(413, `Bundle exceeds ${BUNDLE_BYTE_LIMIT} bytes`);
  if (Number(request.headers.get('Content-Length')) > BUNDLE_BYTE_LIMIT) throw tooLarge();
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BUNDLE_BYTE_LIMIT) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

// The CPU-bound part of the gate, measured for PD2 (apps/api/bench): hash the bytes as received and validate them as a
// bundle. No canonicalization: the hash must equal the committed one, and every verifier recomputes the canonical
// hash itself (backend ADR: bytes hash, no large canonicalization in the request).
export async function inspectBundleBytes(bytes: Uint8Array): Promise<string> {
  const bundleHash = await sha256(bytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new HttpError(422, 'Not a bundle: the bytes are not UTF-8 JSON');
  }
  try {
    validateBundle(value);
  } catch (e) {
    throw new HttpError(422, `Not a valid bundle: ${(e as Error).message}`);
  }
  return bundleHash;
}

// The organizer identity and committed bundle hash of a transaction, from the indexer through the verifier's reads.
async function commitment(
  chain: HostingChain,
  txHash: string,
): Promise<{ owner: string; bundleHash: string; round: number }> {
  try {
    const address = await chain.commitmentOwner(txHash);
    const confirmed = await chain.readCommitment(txHash, address);
    return { owner: identityOf(address).key, bundleHash: confirmed.bundleHash, round: confirmed.round };
  } catch (e) {
    const message = (e as Error).message;
    if (e instanceof NotIndexedError) throw new HttpError(404, 'No commitment with this transaction hash is indexed');
    if (e instanceof CborPendingError || /^Waiting for \d+ confirmations$/.test(message))
      throw new HttpError(409, `The commitment is not confirmed yet (${message}); try again later`);
    if (e instanceof IndexerError || /: unreachable \(/.test(message))
      throw new HttpError(502, `The indexer could not be read: ${message}`);
    throw new HttpError(422, `Not a commitment: ${message}`);
  }
}

const removed = (env: HostingEnv, bundleHash: string) =>
  env.DB.prepare('SELECT 1 FROM tombstones WHERE bundle_hash = ?').bind(bundleHash).first();

// PUT /bundles/{txHash}: host the canonical bundle bytes of an on-chain commitment (BR-06). 201 when hosted, 200 when
// the record already exists (the bytes are written again, which repairs a lost object).
export async function upload(
  env: HostingEnv,
  chain: HostingChain,
  txHash: string,
  request: Request,
  now: number,
): Promise<{ status: 200 | 201; hosted: Hosted }> {
  if (!TX_HASH.test(txHash)) throw new HttpError(400, 'Invalid transaction hash');
  const bytes = await readLimited(request);
  const bundleHash = await inspectBundleBytes(bytes);
  // Checked again atomically by the insert below; this only spares the indexer a removed bundle's reads.
  if (await removed(env, bundleHash)) throw new HttpError(410, 'This bundle was taken down and cannot be hosted again');
  const existing = await env.DB.prepare('SELECT bundle_hash, owner, expires_at FROM hosted WHERE tx_hash = ?')
    .bind(txHash)
    .first<{ bundle_hash: string; owner: string; expires_at: number }>();
  if (existing && existing.expires_at > now) {
    if (existing.bundle_hash !== bundleHash)
      throw new HttpError(409, 'The bundle hash does not match the commitment of this transaction');
    await env.BUNDLES.put(objectKey(bundleHash), bytes);
    return { status: 200, hosted: { txHash, bundleHash, owner: existing.owner, expiresAt: existing.expires_at } };
  }
  if (existing) await release(env, txHash);
  const committed = await commitment(chain, txHash);
  if (committed.bundleHash !== bundleHash)
    throw new HttpError(409, 'The bundle hash does not match the commitment of this transaction');
  const expiresAt = hostingExpiry(committed.round);
  if (expiresAt <= now)
    throw new HttpError(410, 'The hosting period of this draw (12 months after its round) has ended');
  // One statement, so a concurrent takedown or upload by the same owner cannot slip between the checks and the write.
  const inserted = await env.DB.prepare(
    `INSERT INTO hosted (tx_hash, bundle_hash, owner, round, hosted_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE NOT EXISTS (SELECT 1 FROM tombstones WHERE bundle_hash = ?2)
       AND (SELECT COUNT(*) FROM hosted WHERE owner = ?3 AND expires_at > ?5) < ?7
     ON CONFLICT (tx_hash) DO NOTHING`,
  )
    .bind(txHash, bundleHash, committed.owner, committed.round, now, expiresAt, OWNER_QUOTA)
    .run();
  if (inserted.meta.changes !== 1) {
    if (await removed(env, bundleHash))
      throw new HttpError(410, 'This bundle was taken down and cannot be hosted again');
    const raced = await env.DB.prepare('SELECT 1 FROM hosted WHERE tx_hash = ?').bind(txHash).first();
    if (raced) throw new HttpError(409, 'This commitment was hosted by a concurrent request; retry');
    throw new HttpError(403, `The organizer already hosts ${OWNER_QUOTA} bundles (the quota per organizer)`);
  }
  try {
    await env.BUNDLES.put(objectKey(bundleHash), bytes);
  } catch (e) {
    await release(env, txHash);
    throw new HttpError(503, `The bundle could not be stored: ${(e as Error).message}`);
  }
  return { status: 201, hosted: { txHash, bundleHash, owner: committed.owner, expiresAt } };
}

// GET /bundles/{txHash}: the hosted bytes of a commitment. A record past `expires_at` is refused even before the Cron
// sweep removes it (BR-08), and a taken-down bundle is refused whatever records remain.
export async function read(
  env: HostingEnv,
  txHash: string,
  now: number,
): Promise<{ bytes: R2ObjectBody; bundleHash: string }> {
  if (!TX_HASH.test(txHash)) throw new HttpError(400, 'Invalid transaction hash');
  const record = await env.DB.prepare(
    `SELECT bundle_hash, expires_at, EXISTS (SELECT 1 FROM tombstones t WHERE t.bundle_hash = h.bundle_hash) AS removed
     FROM hosted h WHERE tx_hash = ?`,
  )
    .bind(txHash)
    .first<{ bundle_hash: string; expires_at: number; removed: number }>();
  if (!record) throw new HttpError(404, 'No bundle is hosted for this commitment');
  if (record.removed) throw new HttpError(410, 'This bundle was taken down');
  if (record.expires_at <= now) throw new HttpError(410, 'The hosting period of this bundle has ended');
  const bytes = await env.BUNDLES.get(objectKey(record.bundle_hash));
  if (!bytes) throw new HttpError(404, 'The hosted bytes are missing; the owner can upload them again');
  return { bytes, bundleHash: record.bundle_hash };
}

// Deletes the bytes of every given bundle hash no record names any more: the reference count is the number of records,
// read after they were deleted. A bundle still named by another record (the same bytes under another commitment) stays.
async function collect(env: HostingEnv, bundleHashes: string[]): Promise<void> {
  if (!bundleHashes.length) return;
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT value AS bundle_hash FROM json_each(?) WHERE value NOT IN (SELECT bundle_hash FROM hosted)',
  )
    .bind(JSON.stringify(bundleHashes))
    .all<{ bundle_hash: string }>();
  const unreferenced = results.map((row) => objectKey(row.bundle_hash));
  if (unreferenced.length) await env.BUNDLES.delete(unreferenced);
}

// Removes one record (an owner's deletion, plan step 11, or an expired record), and its bytes when no other record
// names them. Returns whether a record was removed.
export async function release(env: HostingEnv, txHash: string): Promise<boolean> {
  const { results } = await env.DB.prepare('DELETE FROM hosted WHERE tx_hash = ? RETURNING bundle_hash')
    .bind(txHash)
    .all<{ bundle_hash: string }>();
  await collect(
    env,
    results.map((row) => row.bundle_hash),
  );
  return results.length > 0;
}

// Operator takedown (a report or a participant's deletion request, BR-13; the manual procedure is plan step 13): every
// record of these bytes goes, and the tombstone keeps anyone from hosting them again.
export async function takedown(env: HostingEnv, bundleHash: string, now: number): Promise<void> {
  if (!TX_HASH.test(bundleHash)) throw new HttpError(400, 'Invalid bundle hash');
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO tombstones (bundle_hash, removed_at) VALUES (?, ?)').bind(bundleHash, now),
    env.DB.prepare('DELETE FROM hosted WHERE bundle_hash = ?').bind(bundleHash),
  ]);
  await env.BUNDLES.delete(objectKey(bundleHash));
}

// The Cron sweep (BR-08): removes up to SWEEP_LIMIT records past `expires_at`, then the bytes no record names any more.
// Returns how many records it removed.
export async function sweep(env: HostingEnv, now: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `DELETE FROM hosted WHERE tx_hash IN (
       SELECT tx_hash FROM hosted WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
     ) RETURNING bundle_hash`,
  )
    .bind(now, SWEEP_LIMIT)
    .all<{ bundle_hash: string }>();
  await collect(
    env,
    results.map((row) => row.bundle_hash),
  );
  return results.length;
}
