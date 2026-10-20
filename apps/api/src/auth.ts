import { decodeBech32, verifyDataSignature } from '@giveaway/chain';
import {
  hex,
  OWNER_OPERATION_VALIDITY,
  type OwnerOperation,
  type OwnerOperationName,
  parseOwnerOperation,
} from '@giveaway/protocol';
import { HttpError } from './http.ts';

// Owner authorization (plan step 11; BR-04, BR-09; invariant B3; ADR 2026-10-18-wallet-auth-and-bounded-retention with
// its PD4 Amendment): every owner operation (host, delete, extend) carries its own CIP-30 signData signature in the
// Authorization header; nothing is issued to the client and nothing about it is stored but the nonce's one-time use.
//
//   Authorization: CIP30 <COSE_Sign1 hex> <COSE_Key hex>
//
// The signed payload is the owner operation text (@giveaway/protocol `ownerOperationText`): domain, operation,
// network, transaction, bundle hash, nonce and its 5-minute window. The signer must be the organizer identity of the
// commitment, the stake key (PD3, PD10), signing for its reward address; the owner is the identity the backend read
// from the commitment transaction (`commitmentOwner`), never an address the wallet reports.
//
// Nonces are issued by the backend (ADR Decision: "伺服器發的一次性 nonce"): GET /nonce draws 16 random bytes,
// records them with the backend's clock in `nonces` (migration 0004) and answers both. A signed message is accepted
// only with a nonce this backend issued, at the issue time recorded for it, within 5 minutes of that time, and the
// row is deleted when the message is used (`consumeNonce`), so it authorizes one operation. Binding the window to the
// issued row is what stops a message signed now from naming a later `issued` time and becoming usable then (review of
// step 11: the window counted from a client-chosen time could be post-dated). The row holds a nonce and a time,
// nothing about the client (B3); issuing writes a row from an unauthenticated request, so GET /nonce is rate limited
// with the write routes, and the Cron sweep deletes rows past their window.

export const NETWORK = 'preprod';
// Generous bounds for the two CBOR hex strings (a COSE_Sign1 carrying a ~600-byte message and a 32-byte key).
const AUTHORIZATION = /^CIP30 ([a-f0-9]{2,4096}) ([a-f0-9]{2,256})$/;

export interface Nonce {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}
// GET /nonce.
export async function issueNonce(db: D1Database, now: number): Promise<Nonce> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  await db.prepare('INSERT INTO nonces (nonce, issued_at) VALUES (?, ?)').bind(nonce, now).run();
  return { nonce, issuedAt: now, expiresAt: now + OWNER_OPERATION_VALIDITY };
}

export interface Signed {
  op: OwnerOperation;
  // The verified signer: the address in the COSE protected header (hex) and its signing credential.
  address: string;
  keyHash: string;
}

// Everything about a signed request that needs neither a record nor the chain: a signature that verifies, over the
// owner operation text for this site (`domain`, the host of the one allowed page origin; null refuses everything),
// this network, this operation and transaction, inside its window. Whose key signed is checked by `requireOwner`.
export function verifySigned(
  request: Request,
  expected: { domain: string | null; operation: OwnerOperationName; txHash: string },
  now: number,
): Signed {
  const header = request.headers.get('Authorization');
  if (header === null)
    throw new HttpError(401, 'This operation needs the owner signature (Authorization: CIP30 <COSE_Sign1> <COSE_Key>)');
  const parts = AUTHORIZATION.exec(header);
  if (!parts)
    throw new HttpError(401, 'Malformed Authorization header (expected CIP30 <COSE_Sign1 hex> <COSE_Key hex>)');
  const signed = verifyDataSignature({ signature: parts[1], key: parts[2] });
  if (!signed) throw new HttpError(401, 'The signature does not verify');
  let op: OwnerOperation;
  try {
    op = parseOwnerOperation(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(signed.payload));
  } catch {
    throw new HttpError(401, 'The signed message is not an owner operation');
  }
  if (expected.domain === null || op.domain !== expected.domain)
    throw new HttpError(401, 'The signed message was written for another site');
  if (op.network !== NETWORK) throw new HttpError(401, `The signed message is for another network than ${NETWORK}`);
  if (op.operation !== expected.operation)
    throw new HttpError(401, `The signed message authorizes "${op.operation}", not "${expected.operation}"`);
  if (op.txHash !== expected.txHash) throw new HttpError(401, 'The signed message names another commitment');
  if (op.issuedAt > now) throw new HttpError(401, 'The signed message was issued in the future');
  if (now >= op.issuedAt + OWNER_OPERATION_VALIDITY)
    throw new HttpError(401, 'The signed message has expired (5 minutes); sign again');
  return { op, address: hex(signed.address), keyHash: signed.keyHash };
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

// Uses up the message's nonce, after the signature and the owner were checked and before the operation runs: the
// issued row must exist with the message's issue time, and deleting it is the one-time use (one statement, so two
// requests with the same message cannot both take it). A failure of the operation afterwards costs the owner a new
// signature, nothing else.
export async function consumeNonce(db: D1Database, op: OwnerOperation): Promise<void> {
  const issued = await db
    .prepare('DELETE FROM nonces WHERE nonce = ?1 AND issued_at = ?2 RETURNING nonce')
    .bind(op.nonce, op.issuedAt)
    .first();
  if (!issued)
    throw new HttpError(
      409,
      'The nonce of this signed message was not issued by this backend or was already used; sign the operation again',
    );
}

// The Cron sweep: a nonce past its window is refused by the time check anyway.
export async function sweepNonces(db: D1Database, now: number, limit: number): Promise<void> {
  await db
    .prepare('DELETE FROM nonces WHERE nonce IN (SELECT nonce FROM nonces WHERE issued_at <= ? LIMIT ?)')
    .bind(now - OWNER_OPERATION_VALIDITY, limit)
    .run();
}
