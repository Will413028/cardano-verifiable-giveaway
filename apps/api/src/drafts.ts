import { DRAFT_ID, hex, sha256, validateServerDraft } from '@giveaway/protocol';
import { draftIdentity, useNonce, verifyDraftSigned } from './auth.ts';
import { readLimited } from './bundles.ts';
import { HttpError } from './http.ts';

// Server drafts (plan step 12; BR-12, BR-18; invariants B3, B5; ADR 2026-10-18-wallet-auth-and-bounded-retention:
// Decision "伺服器草稿需錢包簽章存取，保存 30 天" and the PD4 Amendment's draft identity and quota). Necessity
// condition: the page keeps every draft in the browser's IndexedDB and can export it (apps/web/drafts.ts); the server
// copy exists only so an organizer can carry a draft to another browser or device without handling a file. If the
// product dropped that, these routes, migrations/0005_drafts.sql and the drafts/ objects would have no reason to exist.
//
// - Every route is a signed draft operation (@giveaway/protocol `draftOperationText`), verified like an owner
//   operation (apps/api/src/auth.ts: CIP-30 signData in the Authorization header, a backend nonce used once, 5
//   minutes), with operation names of its own. Nothing else about the signer is kept (B3).
// - A draft belongs to the identity that signed: the wallet's stake key, signing for its reward address (PD4
//   Amendment). Only that identity lists, loads, replaces or deletes it; another identity's request finds no such draft.
// - Each identity holds at most DRAFT_QUOTA drafts, each at most BUNDLE_BYTE_LIMIT bytes (BR-18).
// - A draft is kept DRAFT_RETENTION after its last save (B5: 30 days). Each save is a new signature over the new
//   content, so no stored byte is older than 30 days. Reads refuse it from then on; the Cron deletes the record and
//   the bytes.
// - The bytes must be a draft holding only public labels (validateServerDraft: the page sends the parsed labels, not
//   the raw text or other CSV columns, and the backend refuses anything else). No verification reads a draft (drafts
//   never enter the verification flow).

export interface DraftEnv {
  DB: D1Database;
  // The bucket the hosted bundles use, under its own prefix (drafts/); bundle reconciliation lists only bundles/.
  BUNDLES: R2Bucket;
  NONCE_KEY?: string;
}
// Server drafts per identity at any time (BR-18; PD4 Amendment default, SELF-IMPOSED).
export const DRAFT_QUOTA = 5;
// 30 days (B5), in seconds.
export const DRAFT_RETENTION = 30 * 86400;
// The object key of one save: the save time first (12 digits, so keys sort by it) and a random part. Every save gets
// a new key, so a save never overwrites bytes a concurrent load is reading, and the Cron can find every object older
// than the retention from its key alone, whether or not a record still names it.
const DRAFT_PREFIX = 'drafts/';
export const draftObjectKey = (savedAt: number, token: string) =>
  `${DRAFT_PREFIX}${String(savedAt).padStart(12, '0')}/${token}`;
const savedAtOf = (key: string) => Number(key.slice(DRAFT_PREFIX.length, DRAFT_PREFIX.length + 12));

export interface DraftInfo {
  id: string;
  savedAt: number;
  expiresAt: number;
  size: number;
}

function draftId(id: string): string {
  if (!DRAFT_ID.test(id)) throw new HttpError(400, 'Invalid draft id (32 hex characters)');
  return id;
}

// PUT /drafts/{id}: creates or replaces the signer's draft. The signed message names the draft and the SHA-256 of the
// body. The bytes are written under a new key first; one statement then writes the record only if the draft exists or
// the identity holds fewer than DRAFT_QUOTA live drafts, and the replaced bytes are deleted after it. A failure between
// the two steps leaves bytes no record names: they are deleted by the Cron at the latest when their save time is 30
// days old (`sweepDrafts`), like every draft's bytes.
export async function saveDraft(
  env: DraftEnv,
  request: Request,
  id: string,
  now: number,
  domain: string | null,
): Promise<DraftInfo> {
  draftId(id);
  const signed = await verifyDraftSigned(request, { domain, operation: 'draft-save', draft: id }, now, env.NONCE_KEY);
  const owner = draftIdentity(signed);
  const bytes = await readLimited(request, 'Draft');
  const contentHash = await sha256(bytes);
  if (signed.op.content !== contentHash)
    throw new HttpError(409, 'The signed message names other content than the uploaded draft');
  // Only a draft is kept, and only with the public labels (@giveaway/protocol `validateServerDraft`): the server copy
  // does not rely on the page to leave other CSV columns out, and the storage holds nothing else.
  try {
    validateServerDraft(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)));
  } catch (e) {
    throw new HttpError(422, `Not a server draft: ${(e as Error).message}`);
  }
  await useNonce(env.DB, signed.op);
  const key = draftObjectKey(now, hex(crypto.getRandomValues(new Uint8Array(16))));
  await env.BUNDLES.put(key, bytes);
  const expiresAt = now + DRAFT_RETENTION;
  // A D1 batch is one transaction: the replaced key is read in the same snapshot the upsert writes.
  const [previous, written] = await env.DB.batch([
    env.DB.prepare('SELECT object_key FROM drafts WHERE owner = ?1 AND id = ?2').bind(owner, id),
    env.DB.prepare(
      `INSERT INTO drafts (owner, id, object_key, content_hash, size, saved_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
       WHERE EXISTS (SELECT 1 FROM drafts WHERE owner = ?1 AND id = ?2)
          OR (SELECT COUNT(*) FROM drafts WHERE owner = ?1 AND expires_at > ?6) < ?8
       ON CONFLICT (owner, id) DO UPDATE SET object_key = excluded.object_key, content_hash = excluded.content_hash,
         size = excluded.size, saved_at = excluded.saved_at, expires_at = excluded.expires_at
       RETURNING id`,
    ).bind(owner, id, key, contentHash, bytes.length, now, expiresAt, DRAFT_QUOTA),
  ]);
  if (written.results.length !== 1) {
    await env.BUNDLES.delete(key);
    throw new HttpError(403, `This wallet already keeps ${DRAFT_QUOTA} server drafts (the quota); delete one first`);
  }
  const replaced = (previous.results[0] as { object_key?: string } | undefined)?.object_key;
  if (replaced && replaced !== key) await env.BUNDLES.delete(replaced);
  return { id, savedAt: now, expiresAt, size: bytes.length };
}

// GET /drafts/{id}: the signer's draft bytes, refused once expired even before the Cron removes it.
export async function loadDraft(
  env: DraftEnv,
  request: Request,
  id: string,
  now: number,
  domain: string | null,
): Promise<{ bytes: R2ObjectBody; info: DraftInfo }> {
  draftId(id);
  const signed = await verifyDraftSigned(request, { domain, operation: 'draft-load', draft: id }, now, env.NONCE_KEY);
  const owner = draftIdentity(signed);
  const record = await env.DB.prepare(
    'SELECT object_key, size, saved_at, expires_at FROM drafts WHERE owner = ? AND id = ? AND expires_at > ?',
  )
    .bind(owner, id, now)
    .first<{ object_key: string; size: number; saved_at: number; expires_at: number }>();
  if (!record)
    throw new HttpError(404, 'No such draft for this wallet (drafts are kept 30 days after their last save)');
  await useNonce(env.DB, signed.op);
  const bytes = await env.BUNDLES.get(record.object_key);
  if (!bytes) throw new HttpError(409, 'The draft was replaced or deleted by a concurrent request; load it again');
  return { bytes, info: { id, savedAt: record.saved_at, expiresAt: record.expires_at, size: record.size } };
}

// DELETE /drafts/{id}: the signer deletes its draft, record and bytes.
export async function deleteDraft(
  env: DraftEnv,
  request: Request,
  id: string,
  now: number,
  domain: string | null,
): Promise<{ id: string; deleted: true }> {
  draftId(id);
  const signed = await verifyDraftSigned(request, { domain, operation: 'draft-delete', draft: id }, now, env.NONCE_KEY);
  const owner = draftIdentity(signed);
  await useNonce(env.DB, signed.op);
  const removed = await env.DB.prepare('DELETE FROM drafts WHERE owner = ? AND id = ? RETURNING object_key')
    .bind(owner, id)
    .first<{ object_key: string }>();
  if (!removed) throw new HttpError(404, 'No such draft for this wallet');
  await env.BUNDLES.delete(removed.object_key);
  return { id, deleted: true };
}

// GET /drafts: the signer's live drafts, newest first (at most DRAFT_QUOTA).
export async function listDrafts(
  env: DraftEnv,
  request: Request,
  now: number,
  domain: string | null,
): Promise<{ drafts: DraftInfo[] }> {
  const signed = await verifyDraftSigned(
    request,
    { domain, operation: 'draft-list', draft: 'all' },
    now,
    env.NONCE_KEY,
  );
  const owner = draftIdentity(signed);
  await useNonce(env.DB, signed.op);
  const { results } = await env.DB.prepare(
    `SELECT id, saved_at AS savedAt, expires_at AS expiresAt, size FROM drafts
     WHERE owner = ? AND expires_at > ? ORDER BY saved_at DESC, id`,
  )
    .bind(owner, now)
    .all<DraftInfo>();
  return { drafts: results };
}

// R2 lists up to 1,000 keys per call and deletes up to 1,000 per call; one Cron run examines at most this many pages
// and the next run continues (expired drafts are refused on read meanwhile).
export const DRAFT_SWEEP_PAGES = 10;
// The Cron sweep (B5): deletes every record past its 30 days, then every draft object whose save time (in its key) is
// 30 days old or more. The two are independent: a record expires exactly when its object's key time does (both are
// the save's `now`), and bytes whose record was never written or was replaced while their deletion failed are found
// by their key alone. Keys sort by save time, so the listing stops at the first younger one. Each page is listed from
// the start again: the keys deleted from the previous page are gone from the listing (R2 lists with strong
// consistency), so the next old keys come first.
export async function sweepDrafts(env: DraftEnv, now: number): Promise<void> {
  await env.DB.prepare('DELETE FROM drafts WHERE expires_at <= ?').bind(now).run();
  const cutoff = now - DRAFT_RETENTION;
  for (let page = 0; page < DRAFT_SWEEP_PAGES; page++) {
    const listed = await env.BUNDLES.list({ prefix: DRAFT_PREFIX, limit: 1000 });
    const old = listed.objects.map((object) => object.key).filter((key) => savedAtOf(key) <= cutoff);
    if (old.length) await env.BUNDLES.delete(old);
    if (old.length < listed.objects.length || !listed.truncated) return;
  }
}
