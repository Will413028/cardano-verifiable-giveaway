// CIP-30 signData / CIP-8 COSE_Sign1 verification on the trust path (PD6, ADR 2026-10-18-sdk-and-trust-path-
// dependencies): the read-only CBOR reader plus @noble, no Cardano SDK. Moved from the S1 spike
// (spikes/s1-sdk/options/minimal.mjs `verifyCose`, `sigStructure`, `signingKeyHash`) with its first caller, the
// backend's owner operations (plan step 11); its S1 vectors are tests/cose-vectors.json (tests/cose.test.mjs).
//
// Difference from the spike: the spike compared the signed payload and address with values the caller passed; here
// the verified payload and address are returned, because the backend reads the operation from the payload itself and
// decides separately whose key it accepts (apps/api/src/auth.ts).
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { hex, unhex } from '@giveaway/protocol';
import { decodeCborAll, isCborArray, isCborMap, isCborTag } from './cbor.ts';

// What CIP-30 signData answers: COSE_Sign1 and COSE_Key, both CBOR hex.
export interface DataSignature {
  signature: string;
  key: string;
}
export interface SignedData {
  // The message the key signed (CIP-8: the payload itself, never a hash of it).
  payload: Uint8Array;
  // The address named in the protected header; the key is that address's payment credential (or, for a reward
  // address, its stake credential).
  address: Uint8Array;
  // blake2b-224 of the public key: the credential that signed.
  keyHash: string;
}

const head = (major: number, n: number): number[] =>
  n < 24
    ? [(major << 5) | n]
    : n < 256
      ? [(major << 5) | 24, n]
      : n < 65536
        ? [(major << 5) | 25, n >> 8, n & 255]
        : [(major << 5) | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const byteString = (b: Uint8Array) => [...head(2, b.length), ...b];
// RFC 9052 Sig_structure for COSE_Sign1: ["Signature1", body_protected, external_aad (empty), payload].
export function sigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  const context = new TextEncoder().encode('Signature1');
  return Uint8Array.from([
    ...head(4, 4),
    ...head(3, context.length),
    ...context,
    ...byteString(protectedBytes),
    ...byteString(new Uint8Array()),
    ...byteString(payload),
  ]);
}

// The key-hash credential a CIP-30 signData signer must control for an address (CIP-19 header type): the payment key
// of a base, pointer or enterprise address, the stake key of a reward address. Script credentials cannot sign.
export function signingKeyHash(address: Uint8Array): string {
  const type = address[0] >> 4;
  if (address.length < 29 || ![0, 2, 4, 6, 14].includes(type)) throw new Error('Address credential is not a key hash');
  return hex(address.subarray(1, 29));
}

// The verified content of a CIP-30 DataSignature, or null when anything about it does not hold: COSE_Sign1 (tagged 18
// or not) with EdDSA in the protected header, the signer's address there, an embedded payload that is not flagged as
// hashed, an Ed25519 COSE_Key whose hash is the address's signing credential, and a strict (RFC 8032) Ed25519
// signature over the Sig_structure.
export function verifyDataSignature({ signature, key }: DataSignature): SignedData | null {
  try {
    let sign1 = decodeCborAll(unhex(signature)).value;
    if (isCborTag(sign1) && sign1.tag === 18) sign1 = sign1.value;
    if (!isCborArray(sign1) || sign1.length !== 4) return null;
    const [protectedBytes, unprotected, payload, sig] = sign1;
    if (!(protectedBytes instanceof Uint8Array) || !isCborMap(unprotected)) return null;
    if (!(payload instanceof Uint8Array) || !(sig instanceof Uint8Array) || sig.length !== 64) return null;
    if (unprotected.get('hashed') === true) return null;
    const header = decodeCborAll(protectedBytes).value;
    if (!isCborMap(header) || header.get(1) !== -8n) return null;
    const address = header.get('address');
    if (!(address instanceof Uint8Array)) return null;
    const coseKey = decodeCborAll(unhex(key)).value;
    if (!isCborMap(coseKey) || coseKey.get(1) !== 1n || coseKey.get(-1) !== 6n) return null;
    if (coseKey.has(3) && coseKey.get(3) !== -8n) return null;
    const publicKey = coseKey.get(-2);
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return null;
    const keyHash = hex(blake2b(publicKey, { dkLen: 28 }));
    if (keyHash !== signingKeyHash(address)) return null;
    if (!ed25519.verify(sig, sigStructure(protectedBytes, payload), publicKey, { zip215: false })) return null;
    return { payload, address, keyHash };
  } catch {
    return null;
  }
}
