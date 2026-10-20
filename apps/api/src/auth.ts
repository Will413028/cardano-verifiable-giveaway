import { decodeBech32, verifyDataSignature } from '@giveaway/chain';
import {
  type DraftOperation,
  type DraftOperationName,
  hex,
  unhex,
  OWNER_OPERATION_VALIDITY,
  type OwnerOperation,
  type OwnerOperationName,
  parseDraftOperation,
  parseOwnerOperation,
} from '@giveaway/protocol';
import { HttpError } from './http.ts';

// Owner authorization (plan step 11; BR-04, BR-09; invariant B3; ADR 2026-10-18-wallet-auth-and-bounded-retention with
// its PD4 Amendment): every owner operation (host, delete, extend), and since step 12 every draft operation, carries its own CIP-30 signData signature in the
// Authorization header; nothing is issued to the client and nothing about it is stored but the nonce's one-time use.
//
//   Authorization: CIP30 <COSE_Sign1 hex> <COSE_Key hex>
//
// The signed payload is the owner operation text (@giveaway/protocol `ownerOperationText`): domain, operation,
// network, transaction, bundle hash, nonce and its 5-minute window. The signer must be the organizer identity of the
// commitment, the stake key (PD3, PD10), signing for its reward address; the owner is the identity the backend read
// from the commitment transaction (`commitmentOwner`), never an address the wallet reports.
//
// Nonces are issued by the backend (ADR Decision: "伺服器發的一次性 nonce") without storing them: GET /nonce answers
// random || issued || HMAC-SHA256(NONCE_KEY, random || issued), with `issued` the backend's clock. A signed message is
// accepted only with a nonce whose MAC verifies, whose embedded issue time is the message's `issued`, and only within
// 5 minutes of it; so a message cannot be post-dated (its nonce would have to come from the future) and a nonce
// cannot be invented. One-time use is a row in `used_nonces` (migration 0004), inserted under a uniqueness constraint
// after the signature and the owner were checked: only authenticated owner requests write rows, which is B3's "only
// the one-time nonce's use records". The Cron sweep deletes every row past its window, without a bound per run, since
// a row is refused by the time check from then on anyway.
//
// Why stateless issuing (step 11 review M1): recording each issued nonce let any client grow the table with
// unauthenticated GETs faster than a bounded sweep removes it, and spent a D1 write per GET. NONCE_KEY is a Worker
// secret: tests and `make api` set a non-secret development value, wrangler.jsonc only names it, and the deployed
// value is set at deployment (plan, deferred items). Without it owner operations are refused (503), never accepted.

export const NETWORK = 'preprod';
// Generous bounds for the two CBOR hex strings (a COSE_Sign1 carrying a ~600-byte message and a 32-byte key).
const AUTHORIZATION = /^CIP30 ([a-f0-9]{2,4096}) ([a-f0-9]{2,256})$/;

export interface Nonce {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}
const MAC_INPUT = 22; // 16 random bytes and the issue time as 6 big-endian bytes
const NONCE = /^([a-f0-9]{32})([a-f0-9]{12})([a-f0-9]{64})$/;
async function macKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new HttpError(503, 'Owner operations are not configured (no NONCE_KEY)');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}
const issuedBytes = (issuedAt: number) => {
  const out = new Uint8Array(6);
  let rest = issuedAt;
  for (let i = 5; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
};
// GET /nonce.
export async function issueNonce(secret: string | undefined, now: number): Promise<Nonce> {
  const input = new Uint8Array(MAC_INPUT);
  input.set(crypto.getRandomValues(new Uint8Array(16)));
  input.set(issuedBytes(now), 16);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await macKey(secret), input));
  return { nonce: hex(input) + hex(mac), issuedAt: now, expiresAt: now + OWNER_OPERATION_VALIDITY };
}
// Whether `nonce` was issued by this backend at `issuedAt`.
async function nonceIssued(secret: string | undefined, nonce: string, issuedAt: number): Promise<boolean> {
  const key = await macKey(secret);
  const parts = NONCE.exec(nonce);
  if (!parts) return false;
  if (Number.parseInt(parts[2], 16) !== issuedAt) return false;
  const valid = await crypto.subtle.verify('HMAC', key, unhex(parts[3]), unhex(parts[1] + parts[2]));
  if (!valid) return false;
  return true;
}

export interface Signed<Op = OwnerOperation> {
  op: Op;
  // The verified signer: the address in the COSE protected header (hex) and its signing credential.
  address: string;
  keyHash: string;
}
// What every signed message carries, whichever format (owner operation or draft operation).
interface SignedMessage {
  domain: string;
  operation: string;
  network: string;
  nonce: string;
  issuedAt: number;
}

// Everything about a signed request that needs neither a record nor the chain: a signature that verifies, over a
// message `parse` accepts (it throws for any other text, so a message in another format names no operation here),
// for this site (`domain`, the host of the one allowed page origin; null refuses everything), this network and this
// operation, inside its window, with a nonce this backend issued. Shared by the owner operations and the draft
// operations (plan step 12), which check their own subject (transaction, draft) after it.
async function verifyMessage<Op extends SignedMessage>(
  request: Request,
  parse: (text: string) => Op,
  kind: 'owner' | 'draft',
  expected: { domain: string | null; operation: string },
  now: number,
  nonceKey: string | undefined,
): Promise<Signed<Op>> {
  const header = request.headers.get('Authorization');
  if (header === null)
    throw new HttpError(
      401,
      `This operation needs the ${kind} signature (Authorization: CIP30 <COSE_Sign1> <COSE_Key>)`,
    );
  const parts = AUTHORIZATION.exec(header);
  if (!parts)
    throw new HttpError(401, 'Malformed Authorization header (expected CIP30 <COSE_Sign1 hex> <COSE_Key hex>)');
  const signed = verifyDataSignature({ signature: parts[1], key: parts[2] });
  if (!signed) throw new HttpError(401, 'The signature does not verify');
  let op: Op;
  try {
    op = parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(signed.payload));
  } catch {
    throw new HttpError(401, `The signed message is not ${kind === 'owner' ? 'an owner' : 'a draft'} operation`);
  }
  if (expected.domain === null || op.domain !== expected.domain)
    throw new HttpError(401, 'The signed message was written for another site');
  if (op.network !== NETWORK) throw new HttpError(401, `The signed message is for another network than ${NETWORK}`);
  if (op.operation !== expected.operation)
    throw new HttpError(401, `The signed message authorizes "${op.operation}", not "${expected.operation}"`);
  if (op.issuedAt > now) throw new HttpError(401, 'The signed message was issued in the future');
  if (now >= op.issuedAt + OWNER_OPERATION_VALIDITY)
    throw new HttpError(401, 'The signed message has expired (5 minutes); sign again');
  if (!(await nonceIssued(nonceKey, op.nonce, op.issuedAt)))
    throw new HttpError(401, 'The nonce of the signed message was not issued by this backend at its issue time');
  return { op, address: hex(signed.address), keyHash: signed.keyHash };
}

// An owner operation on a hosted bundle (host, delete, extend) for this transaction. Whose key signed is checked by
// `requireOwner`.
export async function verifySigned(
  request: Request,
  expected: { domain: string | null; operation: OwnerOperationName; txHash: string },
  now: number,
  nonceKey: string | undefined,
): Promise<Signed> {
  const signed = await verifyMessage(request, parseOwnerOperation, 'owner', expected, now, nonceKey);
  if (signed.op.txHash !== expected.txHash) throw new HttpError(401, 'The signed message names another commitment');
  return signed;
}

// A draft operation (plan step 12) for this draft (or 'all' for the listing). Whose drafts these are is
// `draftIdentity`.
export async function verifyDraftSigned(
  request: Request,
  expected: { domain: string | null; operation: DraftOperationName; draft: string },
  now: number,
  nonceKey: string | undefined,
): Promise<Signed<DraftOperation>> {
  const signed = await verifyMessage(request, parseDraftOperation, 'draft', expected, now, nonceKey);
  if (signed.op.draft !== expected.draft) throw new HttpError(401, 'The signed message names another draft');
  return signed;
}

// The identity a draft belongs to (PD4 Amendment: the signing wallet's identity, by the rule of the uniqueness ADR's
// identity subtopic as PD10 left it: the stake key, signing for its reward address). A draft exists before any
// commitment, so unlike `requireOwner` there is no recorded owner to compare with: the signature must be made by the
// stake key of the preprod reward address it names (header e0, key-hash credential = the signing key's hash), and that
// reward address (hex) is the identity. A payment key signing for a base or enterprise address is refused, as for
// owner operations.
export function draftIdentity(signed: Signed<DraftOperation>): string {
  const byStakeKey = signed.address.length === 58 && signed.address === `e0${signed.keyHash}`;
  if (!byStakeKey)
    throw new HttpError(403, "Drafts are signed with the wallet's stake key (sign with its preprod reward address)");
  return signed.address;
}

// The key-versus-owner check: the signature was made by the stake key of `owner` (the organizer identity's stake
// address, read from the commitment transaction) for its reward address.
export function requireOwner(signed: Signed, owner: string): void {
  const account = decodeBech32(owner).bytes;
  const byOwner = signed.address === hex(account) && signed.keyHash === hex(account.subarray(1));
  if (!byOwner)
    throw new HttpError(
      403,
      "The signing key is not this commitment's organizer stake key (sign with its reward address)",
    );
}

// Records the one-time use of the message's nonce, after the signature and the owner were checked and before the
// operation runs. One statement under the primary key, so two requests with the same message cannot both pass. A
// failure of the operation afterwards costs the owner a new signature, nothing else.
//
// The window was checked against the time the request started, and this insert comes later (after D1 reads, and for
// a hosting after the body and the chain reads), so a request verified just inside the window can reach it after the
// Cron sweep removed the earlier use of the same message (step 11 review round 3, reproduced in Miniflare). The
// insert therefore also refuses any message whose window ends at or before the sweep watermark (`nonce_sweep`): the
// sweep raises the watermark and deletes up to it in one transaction, so a row it may have deleted can never be
// inserted again. The watermark is the sweep's own cutoff, not a clock, so Worker and D1 clocks need not agree.
export async function useNonce(db: D1Database, op: Pick<SignedMessage, 'nonce' | 'issuedAt'>): Promise<void> {
  const recorded = await db
    .prepare(
      `INSERT INTO used_nonces (nonce, expires_at)
       SELECT ?1, ?2 WHERE ?2 > (SELECT swept_through FROM nonce_sweep WHERE id = 1)
       ON CONFLICT (nonce) DO NOTHING RETURNING nonce`,
    )
    .bind(op.nonce, op.issuedAt + OWNER_OPERATION_VALIDITY)
    .first();
  if (!recorded)
    throw new HttpError(409, 'This signed message was already used (one-time nonce); sign the operation again');
}

// Use records are kept this long past their window before the sweep may delete them (seconds): a request verified
// inside the window and slower than this to reach `useNonce` is refused (409; the owner signs again) rather than
// accepted, so the margin only spares slow legitimate requests that refusal.
export const NONCE_SWEEP_MARGIN = 3600;
// The Cron sweep: raises the watermark, then deletes every use record at or below it, in one transaction and with no
// per-run bound (rows can only arrive from authenticated owner operations).
export async function sweepNonces(db: D1Database, now: number): Promise<void> {
  const cutoff = now - NONCE_SWEEP_MARGIN;
  await db.batch([
    db.prepare('UPDATE nonce_sweep SET swept_through = max(swept_through, ?) WHERE id = 1').bind(cutoff),
    db.prepare('DELETE FROM used_nonces WHERE expires_at <= (SELECT swept_through FROM nonce_sweep WHERE id = 1)'),
  ]);
}
