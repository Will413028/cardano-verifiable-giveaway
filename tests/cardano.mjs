// Test-only transaction fixtures: a minimal CBOR encoder and Ed25519 keys derived from fixed seeds, so signed
// commitment transactions can be built without any wallet. Never used by the product.
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const unhex = (text) => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
export class Tag {
  constructor(tag, value) {
    this.tag = tag;
    this.value = value;
  }
}
// Pre-encoded bytes, inserted as they are.
export class Raw {
  constructor(bytes) {
    this.bytes = bytes;
  }
}
function head(major, n) {
  const v = BigInt(n);
  if (v < 24n) return [(major << 5) | Number(v)];
  const size = v < 0x100n ? 1 : v < 0x10000n ? 2 : v < 0x100000000n ? 4 : 8;
  const out = [(major << 5) | { 1: 24, 2: 25, 4: 26, 8: 27 }[size]];
  for (let i = size - 1; i >= 0; i--) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  return out;
}
export function encode(value) {
  if (value instanceof Raw) return [...value.bytes];
  if (typeof value === 'number' || typeof value === 'bigint')
    return value < 0 ? head(1, -1n - BigInt(value)) : head(0, value);
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return [...head(3, bytes.length), ...bytes];
  }
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(encode)];
  if (value instanceof Map)
    return [...head(5, value.size), ...[...value].flatMap(([k, v]) => [...encode(k), ...encode(v)])];
  if (value instanceof Tag) return [...head(6, value.tag), ...encode(value.value)];
  if (value === false) return [0xf4];
  if (value === true) return [0xf5];
  if (value === null) return [0xf6];
  throw new Error(`Cannot encode ${value}`);
}
export const cbor = (value) => Uint8Array.from(encode(value));
export const blake2b224 = (bytes) => hex(blake2b(bytes, { dkLen: 28 }));
export const blake2b256 = (bytes) => hex(blake2b(bytes, { dkLen: 32 }));
// A deterministic test key: the secret is 32 copies of `seed`.
export function testKey(seed) {
  const secret = new Uint8Array(32).fill(seed);
  const publicKey = ed25519.getPublicKey(secret);
  return { secret, publicKey, hash: blake2b224(publicKey) };
}
export const sign = (key, message) => ed25519.sign(message, key.secret);

// A signed commitment-shaped transaction. `metadata` is the LABEL entry (object of text/int values) or null;
// `signers` are hex key hashes for required_signers; `witnesses` are keys that sign the transaction id.
// `legacy` uses Shelley encodings (plain arrays, a bare metadata map), the default is Conway (tags 258/259).
// `inputs` ([tx id hex, index] pairs), `outputs` ([address hex, lovelace] pairs) and `fee` replace the default single
// input, 2 ADA output and fee, for balanced transactions a ledger accepts (tools/devchain).
export function buildTransaction({
  label,
  metadata,
  signers = [],
  witnesses = [],
  invalidHereafter = null,
  input = '00'.repeat(32),
  address = `60${'00'.repeat(28)}`,
  inputs = [[input, 0]],
  outputs = [[address, 2_000_000n]],
  fee = 170_000n,
  legacy = false,
  valid = true,
  corruptSignature = false,
}) {
  const set = (items) => (legacy ? items : new Tag(258, items));
  const metadatum = (value) =>
    new Map(Object.entries(value).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v]));
  const auxiliary = metadata
    ? cbor(
        legacy
          ? new Map([[BigInt(label), metadatum(metadata)]])
          : new Tag(259, new Map([[0, new Map([[BigInt(label), metadatum(metadata)]])]])),
      )
    : null;
  const body = new Map([
    [0, set(inputs.map(([id, index]) => [unhex(id), index]))],
    [1, outputs.map(([to, lovelace]) => [unhex(to), BigInt(lovelace)])],
    [2, BigInt(fee)],
  ]);
  if (invalidHereafter !== null) body.set(3, BigInt(invalidHereafter));
  if (auxiliary) body.set(7, blake2b(auxiliary, { dkLen: 32 }));
  if (signers.length) body.set(14, set(signers.map(unhex)));
  const bodyBytes = cbor(body);
  const txId = blake2b(bodyBytes, { dkLen: 32 });
  const vkeys = witnesses.map((key) => {
    const signature = sign(key, txId);
    if (corruptSignature) signature[0] ^= 1;
    return [key.publicKey, signature];
  });
  const witnessSet = new Map(vkeys.length ? [[0, set(vkeys)]] : []);
  const parts = [new Raw(bodyBytes), witnessSet, valid, auxiliary ? new Raw(auxiliary) : null];
  return { txHash: hex(txId), cbor: hex(cbor(legacy ? [parts[0], parts[1], parts[3]] : parts)), auxiliary };
}
// The same transaction with its auxiliary data replaced and nothing else changed: the body, and so the
// transaction id and every witness, stay valid while the declared auxiliary data hash no longer matches.
export function replaceAuxiliary(tx, label, metadata) {
  const aux = cbor(
    new Tag(
      259,
      new Map([
        [
          0,
          new Map([
            [
              BigInt(label),
              new Map(Object.entries(metadata).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v])),
            ],
          ]),
        ],
      ]),
    ),
  );
  const original = hex(tx.auxiliary);
  if (!tx.cbor.endsWith(original)) throw new Error('auxiliary data is not the last element');
  return { ...tx, cbor: tx.cbor.slice(0, -original.length) + hex(aux) };
}
