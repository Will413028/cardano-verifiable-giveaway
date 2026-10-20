// The message an organizer signs with CIP-30 signData to host, delete or extend a hosted bundle (plan step 11; BR-09;
// ADR 2026-10-18-wallet-auth-and-bounded-retention, Decision and PD4 Amendment). It is the backend's authorization
// format, not part of the verification protocol: no verifier reads it (B1). The page writes it, the wallet shows it
// as text, and the backend accepts exactly the text `ownerOperationText` renders (one field per line, fixed order),
// so what the organizer saw is what was checked.

export const OWNER_OPERATION_FORMAT = 'giveaway-owner-operation-1';
export const OWNER_OPERATIONS = ['host', 'delete', 'extend'] as const;
export type OwnerOperationName = (typeof OWNER_OPERATIONS)[number];
// A signed message is accepted for this long after the backend issued its nonce (seconds; CIP-93's suggested window).
export const OWNER_OPERATION_VALIDITY = 300;

export interface OwnerOperation {
  // The page's host (host[:port]) that asked for the signature.
  domain: string;
  operation: OwnerOperationName;
  // 'preprod' is the only network the backend hosts for; the field is still read, so a message signed for another
  // network is refused by the backend's check rather than by its shape.
  network: string;
  // The commitment transaction the hosting record is keyed by, and the bundle hash it committed.
  txHash: string;
  bundleHash: string;
  // From the backend's nonce endpoint: 16 random bytes (hex) and its clock (Unix seconds).
  nonce: string;
  issuedAt: number;
}

const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const DOMAIN = /^[a-z0-9.-]{1,253}(?::[0-9]{1,5})?$/;
const time = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

export function ownerOperationText(op: OwnerOperation): string {
  return [
    `Open Draw owner operation (${OWNER_OPERATION_FORMAT})`,
    `domain: ${op.domain}`,
    `operation: ${op.operation}`,
    `network: ${op.network}`,
    `transaction: ${op.txHash}`,
    `bundle: ${op.bundleHash}`,
    `nonce: ${op.nonce}`,
    `issued: ${time(op.issuedAt)}`,
    `expires: ${time(op.issuedAt + OWNER_OPERATION_VALIDITY)}`,
  ].join('\n');
}

// The operation a signed message names; throws unless the text is exactly what ownerOperationText renders for it.
// Field values are checked for shape only: whether they fit the request (domain, network, operation, transaction,
// bundle, time, nonce use) is the backend's decision.
export function parseOwnerOperation(text: string): OwnerOperation {
  const fields = new Map<string, string>();
  for (const line of text.split('\n').slice(1)) {
    const at = line.indexOf(': ');
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 2));
  }
  const field = (name: string, shape: RegExp) => {
    const value = fields.get(name) ?? '';
    if (!shape.test(value)) throw new Error(`Owner operation: invalid ${name}`);
    return value;
  };
  const operation = field('operation', /^[a-z]+$/) as OwnerOperationName;
  if (!OWNER_OPERATIONS.includes(operation)) throw new Error('Owner operation: unknown operation');
  const issued = Date.parse(field('issued', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/));
  if (!Number.isSafeInteger(issued)) throw new Error('Owner operation: invalid issued');
  const op: OwnerOperation = {
    domain: field('domain', DOMAIN),
    operation,
    network: field('network', /^[a-z]{1,16}$/),
    txHash: field('transaction', HASH),
    bundleHash: field('bundle', HASH),
    nonce: field('nonce', NONCE),
    issuedAt: issued / 1000,
  };
  if (ownerOperationText(op) !== text) throw new Error('Owner operation: not the canonical message text');
  return op;
}
