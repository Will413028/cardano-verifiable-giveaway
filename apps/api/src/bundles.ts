import { type BlockfrostChain, CborPendingError, IndexerError, identityOf, NotIndexedError } from '@giveaway/chain';
import {
  BUNDLE_BYTE_LIMIT,
  type Bundle,
  type Confirmed,
  canonicalize,
  matchesCommitment,
  sha256,
  validateBundle,
} from '@giveaway/protocol';
import { hostingExpiry, roundExpiry, SWEEP_LIMIT } from './retention.ts';

// Bundle hosting (plan step 10; BR-06, BR-07, BR-08, BR-17; invariant B4; ADR 2026-10-18-wallet-auth-and-bounded-
// retention with Amendment 2). Records live in D1 (migrations/0001_bundle_hosting.sql), bytes in R2.
//
// - A record is keyed by the commitment's txHash and owned by the organizer identity read from that transaction, so
//   anyone committing the same bundle hash in their own transaction gets their own record and cannot take over or
//   block another's (Amendment 2).
// - Bytes are stored once per bundle hash (`bundles/<sha256>`) and shared by every record naming it; they are deleted
//   when the last record goes (reference counting by the records themselves, so no counter can drift). The bytes are
//   the canonical serialization of the bundle (the ADR hosts canonical bundle bytes only), so the hash is the one every
//   verifier computes.
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

// The CPU-bound part of the gate, measured for PD2 (apps/api/bench): hash the bytes, require them to be the canonical
// serialization of what they parse to, and validate that as a bundle. The canonical check comes first: it is one linear
// serialization and refuses non-canonical bytes before validateBundle's per-label work.
//
// Why canonical, not merely "parses to a valid bundle": JSON.parse keeps the last of duplicate keys, so
// `{"entrants":"<anything>",…,"entrants":["a"],…}` parses to a valid bundle while the bytes carry anything; committing
// their hash in one's own transaction would then host arbitrary content (ADR: canonical bundle bytes only, and
// validateBundle exists so one fee cannot park an arbitrary file). Decoding is fatal and keeps a byte order mark (which
// JSON.parse then refuses), so equal text means equal bytes: what is stored hashes to computeCommitment(bundle).
export async function inspectBundleBytes(bytes: Uint8Array): Promise<{ bundleHash: string; bundle: Bundle }> {
  const bundleHash = await sha256(bytes);
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new HttpError(422, 'Not a bundle: the bytes are not UTF-8 JSON');
  }
  let canonical: string | null;
  try {
    canonical = canonicalize(value);
  } catch {
    canonical = null;
  }
  if (canonical !== text)
    throw new HttpError(
      422,
      'Not canonical bundle bytes: upload exactly the downloaded bundle file (sorted keys, no whitespace, no duplicate keys)',
    );
  let bundle: Bundle;
  try {
    bundle = validateBundle(value);
  } catch (e) {
    throw new HttpError(422, `Not a valid bundle: ${(e as Error).message}`);
  }
  return { bundleHash, bundle };
}

// The organizer identity and the commitment of a transaction, from the indexer through the verifier's reads.
async function commitment(chain: HostingChain, txHash: string): Promise<{ owner: string; committed: Confirmed }> {
  try {
    const address = await chain.commitmentOwner(txHash);
    const committed = await chain.readCommitment(txHash, address);
    return { owner: identityOf(address).key, committed };
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

// Writing and deleting bytes (review M2). D1 holds the records, R2 the bytes, and no transaction spans both, so each
// side effect is ordered and checked so that every interleaving ends with bytes exactly where a live record names them:
//
// - Upload: insert the record, then write the bytes, then check the record is still there (`confirmStored`). A
//   takedown or deletion that ran in between has already deleted the object, and the write has just put it back; the
//   check sees the record gone, deletes the bytes again (unconditionally after a takedown: its tombstone means no
//   record can name them again) and the upload fails instead of answering 201. If the check finds the record, the bytes
//   were written while it existed, and a deletion that removes it later runs after the write.
// - Deletion (`collect`): a hash is claimed in D1 (table `collecting`) only while no record names it, and no record is
//   inserted while a claim stands (the upload's INSERT checks it), so the bytes of a claimed hash are nobody's and
//   deleting them cannot hit an upload that slipped in after the reference count was read. The claim is released after
//   the delete; an upload meanwhile is refused with 409 and succeeds when retried.
// - Reconciliation (`reconcile`, every Cron run): a deletion that failed or stopped after its record went (or an upload
//   that stopped between writing back removed bytes and checking) leaves an object nothing else revisits. The Cron run
//   finishes claims older than CLAIM_STALE and scans one page of the bucket per run, deleting through `collect`, so it
//   never deletes bytes a record names.
//
// Necessity condition: R2 has no conditional delete and D1 and R2 share no transaction. If both lived in one
// transactional store, the claim table and the post-write check would have no reason to exist; the reconciliation
// would still be needed for any store whose deletes can fail after the record is gone.

// A claim older than this (seconds) belongs to a request that stopped before releasing it; the Cron reconciliation
// finishes it. Assumption (inferred, not measured): a request holding a claim finishes its R2 delete within an hour.
export const CLAIM_STALE = 3600;
// Objects one Cron run examines (one R2 list page; R2 deletes up to 1,000 keys per call).
export const RECONCILE_LIMIT = 1000;

// After writing the bytes of a record: the record must still exist, or the bytes go and the upload fails.
async function confirmStored(env: HostingEnv, txHash: string, bundleHash: string, now: number): Promise<void> {
  const live = await env.DB.prepare('SELECT 1 FROM hosted WHERE tx_hash = ? AND bundle_hash = ?')
    .bind(txHash, bundleHash)
    .first();
  if (live) return;
  if (await removed(env, bundleHash)) {
    await env.BUNDLES.delete(objectKey(bundleHash));
    throw new HttpError(410, 'This bundle was taken down and cannot be hosted again');
  }
  await collect(env, [bundleHash], now);
  throw new HttpError(409, 'This hosting record was removed by a concurrent request; upload again to host it');
}

// PUT /bundles/{txHash}: host the canonical bundle bytes of an on-chain commitment (BR-06). 201 when hosted, 200 when
// the record already exists (the bytes are written again, which repairs a lost object).
//
// Order (review L2): every check that needs no chain read runs first, validateBundle (about 0.1 s CPU on 10,000
// labels, PD2 step 10b) included, so the indexer is read only for bytes that are a valid canonical bundle; reading the chain
// first would let anyone turn each request into indexer reads of the project Dolos instead. The CPU cost per request
// is bounded by BUNDLE_BYTE_LIMIT; per-IP rate limiting of the backend's write routes comes with the signed owner
// operations (plan step 11).
export async function upload(
  env: HostingEnv,
  chain: HostingChain,
  txHash: string,
  request: Request,
  now: number,
): Promise<{ status: 200 | 201; hosted: Hosted }> {
  if (!TX_HASH.test(txHash)) throw new HttpError(400, 'Invalid transaction hash');
  const bytes = await readLimited(request);
  const { bundleHash, bundle } = await inspectBundleBytes(bytes);
  // Checked again atomically by the insert below; this only spares the indexer a removed bundle's reads.
  if (await removed(env, bundleHash)) throw new HttpError(410, 'This bundle was taken down and cannot be hosted again');
  const existing = await env.DB.prepare('SELECT bundle_hash, owner, expires_at FROM hosted WHERE tx_hash = ?')
    .bind(txHash)
    .first<{ bundle_hash: string; owner: string; expires_at: number }>();
  if (existing && existing.expires_at > now) {
    if (existing.bundle_hash !== bundleHash)
      throw new HttpError(409, 'The bundle hash does not match the commitment of this transaction');
    await env.BUNDLES.put(objectKey(bundleHash), bytes);
    await confirmStored(env, txHash, bundleHash, now);
    return { status: 200, hosted: { txHash, bundleHash, owner: existing.owner, expiresAt: existing.expires_at } };
  }
  if (existing) await release(env, txHash, now);
  const { owner, committed } = await commitment(chain, txHash);
  // The verifier's own bundle-to-commitment check (hash, drawId, drand round): the round the retention may be counted
  // from is then the bundle's, which every verifier holds the commitment to, not a number only the metadata carries.
  if (!matchesCommitment(bundle, bundleHash, committed))
    throw new HttpError(
      409,
      bundleHash !== committed.bundleHash
        ? 'The bundle hash does not match the commitment of this transaction'
        : 'The bundle drawId or drand round differs from the commitment of this transaction',
    );
  const round = bundle.drand.round;
  // Retention counts from the first time this commitment was hosted, not from this upload (ADR Amendment 5): the row
  // outlives the record, so uploading again after an expiry, a deletion or a takedown starts no new period.
  const first = await env.DB.prepare('SELECT first_hosted_at FROM first_hosting WHERE tx_hash = ?')
    .bind(txHash)
    .first<{ first_hosted_at: number }>();
  const firstHosted = first?.first_hosted_at ?? now;
  const expiresAt = hostingExpiry(round, firstHosted);
  if (expiresAt <= now)
    throw new HttpError(
      410,
      'The hosting period of this draw has ended (12 months after its round or its first hosting, whichever came first)',
    );
  // One statement, so a concurrent takedown, deletion claim or upload by the same owner cannot slip between the checks
  // and the write; the first hosting time is recorded in the same transaction (a D1 batch), only when this insert
  // made the record.
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO hosted (tx_hash, bundle_hash, owner, round, hosted_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
     WHERE NOT EXISTS (SELECT 1 FROM tombstones WHERE bundle_hash = ?2)
       AND NOT EXISTS (SELECT 1 FROM collecting WHERE bundle_hash = ?2)
       AND (SELECT COUNT(*) FROM hosted WHERE owner = ?3 AND expires_at > ?5) < ?7
     ON CONFLICT (tx_hash) DO NOTHING`,
    ).bind(txHash, bundleHash, owner, round, now, expiresAt, OWNER_QUOTA),
    env.DB.prepare(
      `INSERT INTO first_hosting (tx_hash, first_hosted_at, keep_until)
       SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM hosted WHERE tx_hash = ?1 AND hosted_at = ?2)
       ON CONFLICT (tx_hash) DO NOTHING`,
    ).bind(txHash, now, roundExpiry(round)),
  ]);
  if (inserted.meta.changes !== 1) {
    if (await removed(env, bundleHash))
      throw new HttpError(410, 'This bundle was taken down and cannot be hosted again');
    const raced = await env.DB.prepare('SELECT 1 FROM hosted WHERE tx_hash = ?').bind(txHash).first();
    if (raced) throw new HttpError(409, 'This commitment was hosted by a concurrent request; retry');
    const collecting = await env.DB.prepare('SELECT 1 FROM collecting WHERE bundle_hash = ?').bind(bundleHash).first();
    if (collecting) throw new HttpError(409, 'These bytes are being deleted by a concurrent request; retry');
    throw new HttpError(403, `The organizer already hosts ${OWNER_QUOTA} bundles (the quota per organizer)`);
  }
  try {
    await env.BUNDLES.put(objectKey(bundleHash), bytes);
  } catch (e) {
    await release(env, txHash, now);
    throw new HttpError(503, `The bundle could not be stored: ${(e as Error).message}`);
  }
  await confirmStored(env, txHash, bundleHash, now);
  return { status: 201, hosted: { txHash, bundleHash, owner, expiresAt } };
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

// Deletes the bytes of every given bundle hash no record names: the reference count is the number of records, read in
// the same statement that claims the hash (see "Writing and deleting bytes" above). A bundle still named by another
// record (the same bytes under another commitment) stays; a hash another request has claimed is left to it.
async function collect(env: HostingEnv, bundleHashes: string[], now: number): Promise<void> {
  if (!bundleHashes.length) return;
  const token = crypto.randomUUID();
  const { results } = await env.DB.prepare(
    `INSERT INTO collecting (bundle_hash, token, since)
     SELECT DISTINCT value, ?2, ?3 FROM json_each(?1) WHERE value NOT IN (SELECT bundle_hash FROM hosted)
     ON CONFLICT (bundle_hash) DO NOTHING
     RETURNING bundle_hash`,
  )
    .bind(JSON.stringify(bundleHashes), token, now)
    .all<{ bundle_hash: string }>();
  const unreferenced = results.map((row) => objectKey(row.bundle_hash));
  if (!unreferenced.length) return;
  // A failure here leaves the claims standing: no record can name these hashes until the Cron reconciliation deletes
  // the bytes and releases them.
  await env.BUNDLES.delete(unreferenced);
  await env.DB.prepare('DELETE FROM collecting WHERE token = ?').bind(token).run();
}

// Removes one record (an owner's deletion, plan step 11, or an expired record), and its bytes when no other record
// names them. Returns whether a record was removed.
export async function release(env: HostingEnv, txHash: string, now: number): Promise<boolean> {
  const { results } = await env.DB.prepare('DELETE FROM hosted WHERE tx_hash = ? RETURNING bundle_hash')
    .bind(txHash)
    .all<{ bundle_hash: string }>();
  await collect(
    env,
    results.map((row) => row.bundle_hash),
    now,
  );
  return results.length > 0;
}

// Operator takedown (a report or a participant's deletion request, BR-13; the manual procedure is plan step 13): every
// record of these bytes goes, and the tombstone keeps anyone from hosting them again. The delete needs no claim: after
// the tombstone no record can name these bytes again. If it fails, the Cron reconciliation deletes them.
export async function takedown(env: HostingEnv, bundleHash: string, now: number): Promise<void> {
  if (!TX_HASH.test(bundleHash)) throw new HttpError(400, 'Invalid bundle hash');
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO tombstones (bundle_hash, removed_at) VALUES (?, ?)').bind(bundleHash, now),
    env.DB.prepare('DELETE FROM hosted WHERE bundle_hash = ?').bind(bundleHash),
  ]);
  await env.BUNDLES.delete(objectKey(bundleHash));
}

// The Cron sweep (BR-08): removes up to SWEEP_LIMIT records past `expires_at`, then the bytes no record names any more,
// then first hosting times that no longer matter.
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
    now,
  );
  // A first hosting time stops mattering 12 months after the round: from then on the round time alone ends any
  // hosting period of that commitment (ADR Amendment 5), so deleting the row reopens nothing.
  await env.DB.prepare(
    'DELETE FROM first_hosting WHERE tx_hash IN (SELECT tx_hash FROM first_hosting WHERE keep_until <= ? LIMIT ?)',
  )
    .bind(now, SWEEP_LIMIT)
    .run();
  return results.length;
}

// The Cron reconciliation (see "Writing and deleting bytes" above): finishes stale claims, then examines one page of
// the bucket, resuming after the last key the previous run examined and starting over once the listing is exhausted.
export async function reconcile(env: HostingEnv, now: number): Promise<void> {
  // A claimed hash has no record and cannot get one while the claim stands, so its bytes may go.
  const { results: stale } = await env.DB.prepare(
    'SELECT bundle_hash, token FROM collecting WHERE since <= ? ORDER BY since LIMIT ?',
  )
    .bind(now - CLAIM_STALE, RECONCILE_LIMIT)
    .all<{ bundle_hash: string; token: string }>();
  if (stale.length) {
    await env.BUNDLES.delete(stale.map((row) => objectKey(row.bundle_hash)));
    // One statement, not a batch of up to RECONCILE_LIMIT statements (D1 limits the queries per invocation).
    await env.DB.prepare(
      `DELETE FROM collecting WHERE (bundle_hash, token) IN
         (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`,
    )
      .bind(JSON.stringify(stale.map((row) => [row.bundle_hash, row.token])))
      .run();
  }
  const cursor = await env.DB.prepare('SELECT after FROM reconcile_cursor WHERE id = 1').first<{ after: string }>();
  const after = cursor?.after ?? '';
  const listed = await env.BUNDLES.list({
    prefix: objectKey(''),
    limit: RECONCILE_LIMIT,
    ...(after ? { startAfter: after } : {}),
  });
  await collect(
    env,
    listed.objects.map((object) => object.key.slice(objectKey('').length)),
    now,
  );
  const next = listed.truncated ? (listed.objects.at(-1)?.key ?? '') : '';
  await env.DB.prepare('UPDATE reconcile_cursor SET after = ? WHERE id = 1').bind(next).run();
}
