import { ed25519 } from '@noble/curves/ed25519.js';
import { env } from 'cloudflare:test';
import { decodeBech32 } from '@giveaway/chain';
import { hex, type OwnerOperation, type OwnerOperationName, ownerOperationText } from '@giveaway/protocol';
import { issueNonce } from '../src/auth.ts';
import fixture from './chain-fixture.json';

// A CIP-30 signData stand-in for the backend tests: CIP-8 COSE_Sign1 and COSE_Key built from the RFC 9052 structure
// with the deterministic test keys of tools/api-fixture.mjs (secret = 32 copies of the seed), never with the code
// under test. A real wallet signs the same structure (the S1 vectors, tests/cose-vectors.json, include Evolution and
// Mesh output).

type Item = number | string | Uint8Array | Item[] | Map<number | string, Item> | boolean;
const head = (major: number, n: number): number[] =>
  n < 24
    ? [(major << 5) | n]
    : n < 256
      ? [(major << 5) | 24, n]
      : n < 65536
        ? [(major << 5) | 25, n >> 8, n & 255]
        : [(major << 5) | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
function encode(value: Item): number[] {
  if (typeof value === 'boolean') return [value ? 0xf5 : 0xf4];
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(encode)];
  return [...head(5, value.size), ...[...value].flatMap(([k, v]) => [...encode(k), ...encode(v)])];
}
const cbor = (value: Item) => Uint8Array.from(encode(value));

export const secretOf = (seed: number) => new Uint8Array(32).fill(seed);
// The organizer identities of the fixture and their stake key seeds (tools/api-fixture.mjs).
export const SEEDS = { organizer: 2, other: 5, busy: 9 } as const;
export type Who = keyof typeof SEEDS;
export const rewardAddress = (who: Who) => decodeBech32(fixture.owners[who]).bytes;

// What a wallet's signData(address, payload) answers, signed by `secret` for `address`.
export function signData(secret: Uint8Array, address: Uint8Array, payload: Uint8Array) {
  const protectedBytes = cbor(
    new Map<number | string, Item>([
      [1, -8],
      ['address', address],
    ]),
  );
  const toSign = cbor(['Signature1', protectedBytes, new Uint8Array(), payload]);
  const signature = ed25519.sign(toSign, secret);
  const sign1 = cbor([protectedBytes, new Map([['hashed', false]]), payload, signature]);
  const key = cbor(
    new Map<number, Item>([
      [1, 1],
      [3, -8],
      [-1, 6],
      [-2, ed25519.getPublicKey(secret)],
    ]),
  );
  return { signature: hex(sign1), key: hex(key) };
}

export const DOMAIN = '127.0.0.1:4320';
// A nonce the backend issues at `issuedAt` (GET /nonce's own function with the test NONCE_KEY of vitest.config.ts), so a
// test can sign for any time it injects.
export const NONCE_KEY = (env as unknown as { NONCE_KEY: string }).NONCE_KEY;
export async function issuedNonce(issuedAt: number): Promise<string> {
  return (await issueNonce(NONCE_KEY, issuedAt)).nonce;
}

// The Authorization header of an owner operation, by default as the page would build it: signed by `who`'s stake key
// for its reward address, for this site and preprod, with a nonce issued `at`. Each field can be replaced to build a
// bad one.
export async function authorization(
  who: Who,
  fields: Pick<OwnerOperation, 'txHash' | 'bundleHash'> & { operation: OwnerOperationName; at: number } & Partial<
      OwnerOperation & { secret: Uint8Array; address: Uint8Array; text: string }
    >,
): Promise<string> {
  const issuedAt = fields.issuedAt ?? fields.at;
  const op: OwnerOperation = {
    domain: fields.domain ?? DOMAIN,
    operation: fields.operation,
    network: fields.network ?? 'preprod',
    txHash: fields.txHash,
    bundleHash: fields.bundleHash,
    nonce: fields.nonce ?? (await issuedNonce(issuedAt)),
    issuedAt,
  };
  const payload = new TextEncoder().encode(fields.text ?? ownerOperationText(op));
  const { signature, key } = signData(
    fields.secret ?? secretOf(SEEDS[who]),
    fields.address ?? rewardAddress(who),
    payload,
  );
  return `CIP30 ${signature} ${key}`;
}
