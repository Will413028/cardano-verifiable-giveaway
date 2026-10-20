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
// The nonce endpoint is stateless: it hands out 16 random bytes and the backend's clock. Freshness is the window
// counted from that clock (a page with a wrong clock still signs a message the backend accepts), and one-time use is
// the `used_nonces` row written with the operation. The backend does not remember which nonces it issued: that would
// make an unauthenticated GET write a row, and it would add nothing against replay, since only the owner's key can
// sign a message and each signed message is used at most once and only inside its window.

export const NETWORK = 'preprod';
// Generous bounds for the two CBOR hex strings (a COSE_Sign1 carrying a ~600-byte message and a 32-byte key).
const AUTHORIZATION = /^CIP30 ([a-f0-9]{2,4096}) ([a-f0-9]{2,256})$/;

export interface Nonce {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}
// GET /nonce.
export function issueNonce(now: number): Nonce {
  return {
    nonce: hex(crypto.getRandomValues(new Uint8Array(16))),
    issuedAt: now,
    expiresAt: now + OWNER_OPERATION_VALIDITY,
  };
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

// Records the one-time use of the message's nonce. Put it in the same D1 batch as the operation it authorizes: a
// nonce used before violates the primary key, the batch rolls back, and `nonceReused` recognizes the error.
export function useNonce(db: D1Database, op: OwnerOperation): D1PreparedStatement {
  return db
    .prepare('INSERT INTO used_nonces (nonce, expires_at) VALUES (?, ?)')
    .bind(op.nonce, op.issuedAt + OWNER_OPERATION_VALIDITY);
}
export const nonceReused = (e: unknown) => /UNIQUE constraint failed: used_nonces\.nonce/.test(String(e));
export const reusedNonce = () =>
  new HttpError(409, 'This signed message was already used (one-time nonce); sign the operation again');

// The Cron sweep: a nonce whose message has expired is refused by the time check anyway.
export async function sweepNonces(db: D1Database, now: number, limit: number): Promise<void> {
  await db
    .prepare('DELETE FROM used_nonces WHERE nonce IN (SELECT nonce FROM used_nonces WHERE expires_at <= ? LIMIT ?)')
    .bind(now, limit)
    .run();
}
