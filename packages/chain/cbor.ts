// Read-only CBOR reader for the trust path (PD6, ADR 2026-10-18-sdk-and-trust-path-dependencies). It keeps the raw
// byte range of every array and map element, so hashes are taken over the bytes as submitted and never over a
// re-encoding. Moved from the S1 spike (spikes/s1-sdk/options/minimal.mjs); hashing is @noble/hashes.
import { blake2b } from '@noble/hashes/blake2.js';
import { hex, unhex } from '@giveaway/protocol';

export type CborKey = number | string | Uint8Array | boolean | null | undefined | CborValue;
export type Span = readonly [start: number, end: number];
export interface CborArray extends Array<CborValue> {
  spans: Span[];
}
export interface CborMap extends Map<CborKey, CborValue> {
  spans: Map<CborKey, Span>;
}
export interface CborTag {
  tag: number;
  value: CborValue;
  span: Span;
}
// Integers are bigint; text is string; byte strings are Uint8Array; simple values are boolean, null or undefined.
export type CborValue = bigint | string | Uint8Array | boolean | null | undefined | CborArray | CborMap | CborTag;
export interface CborItem {
  value: CborValue;
  start: number;
  end: number;
}

const MAX_DEPTH = 64;
export function decodeCbor(bytes: Uint8Array, at = 0, depth = 0): CborItem {
  if (depth > MAX_DEPTH) throw new Error('CBOR nesting too deep');
  const start = at;
  let pos = at;
  if (pos >= bytes.length) throw new Error('CBOR truncated');
  const initial = bytes[pos++];
  const major = initial >> 5;
  const info = initial & 31;
  const argument = (): bigint => {
    if (info < 24) return BigInt(info);
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (size < 0 || pos + size > bytes.length) throw new Error('CBOR bad length');
    let v = 0n;
    for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(bytes[pos++]);
    return v;
  };
  const length = (): number => {
    const v = argument();
    if (v > BigInt(bytes.length)) throw new Error('CBOR length exceeds input');
    return Number(v);
  };
  const definite = (): Uint8Array => {
    const n = length();
    if (pos + n > bytes.length) throw new Error('CBOR truncated');
    const out = bytes.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  // Indefinite-length byte or text string: definite chunks of the same major type until the break byte.
  const chunks = (): Uint8Array[] => {
    const parts: Uint8Array[] = [];
    while (bytes[pos] !== 0xff) {
      if (pos >= bytes.length) throw new Error('CBOR truncated');
      if (bytes[pos] >> 5 !== major || (bytes[pos] & 31) === 31) throw new Error('CBOR bad chunk');
      const chunk = decodeCbor(bytes, pos, depth + 1);
      parts.push(typeof chunk.value === 'string' ? new TextEncoder().encode(chunk.value) : (chunk.value as Uint8Array));
      pos = chunk.end;
    }
    pos++;
    return parts;
  };
  const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  };
  // ignoreBOM keeps a leading U+FEFF in the text instead of silently dropping bytes that are on chain.
  const utf8 = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b);
  let value: CborValue;
  switch (major) {
    case 0:
      value = argument();
      break;
    case 1:
      value = -1n - argument();
      break;
    case 2:
      value = info === 31 ? concat(chunks()) : definite().slice();
      break;
    case 3:
      value = utf8(info === 31 ? concat(chunks()) : definite());
      break;
    case 4: {
      const list = Object.assign([] as CborValue[], { spans: [] as Span[] });
      const n = info === 31 ? Number.POSITIVE_INFINITY : length();
      for (let i = 0; i < n && !(info === 31 && bytes[pos] === 0xff); i++) {
        const item = decodeCbor(bytes, pos, depth + 1);
        list.push(item.value);
        list.spans.push([item.start, item.end]);
        pos = item.end;
      }
      if (info === 31) pos++;
      value = list;
      break;
    }
    case 5: {
      const map = Object.assign(new Map<CborKey, CborValue>(), { spans: new Map<CborKey, Span>() });
      const n = info === 31 ? Number.POSITIVE_INFINITY : length();
      for (let i = 0; i < n && !(info === 31 && bytes[pos] === 0xff); i++) {
        const k = decodeCbor(bytes, pos, depth + 1);
        const v = decodeCbor(bytes, k.end, depth + 1);
        // Integer keys become numbers so lookups like body.get(0) work; a key beyond 2^53 is rejected rather than
        // rounded onto another key.
        if (
          typeof k.value === 'bigint' &&
          (k.value > BigInt(Number.MAX_SAFE_INTEGER) || k.value < -BigInt(Number.MAX_SAFE_INTEGER))
        )
          throw new Error('CBOR map key out of range');
        const key: CborKey = typeof k.value === 'bigint' ? Number(k.value) : k.value;
        if (map.has(key)) throw new Error('CBOR duplicate map key');
        map.set(key, v.value);
        map.spans.set(key, [v.start, v.end]);
        pos = v.end;
      }
      if (info === 31) pos++;
      value = map;
      break;
    }
    case 6: {
      const tag = argument();
      const item = decodeCbor(bytes, pos, depth + 1);
      value = { tag: Number(tag), value: item.value, span: [item.start, item.end] };
      pos = item.end;
      break;
    }
    default:
      if (info === 20) value = false;
      else if (info === 21) value = true;
      else if (info === 22) value = null;
      else if (info === 23) value = undefined;
      else throw new Error('CBOR float or simple value unsupported');
  }
  return { value, start, end: pos };
}
export function decodeCborAll(bytes: Uint8Array): CborItem {
  const item = decodeCbor(bytes);
  if (item.end !== bytes.length) throw new Error('CBOR trailing bytes');
  return item;
}

export const isCborMap = (v: unknown): v is CborMap => v instanceof Map;
export const isCborArray = (v: unknown): v is CborArray => Array.isArray(v);
export const isCborTag = (v: unknown): v is CborTag =>
  typeof v === 'object' && v !== null && !(v instanceof Uint8Array) && !Array.isArray(v) && !(v instanceof Map);
const blake2b256 = (b: Uint8Array) => hex(blake2b(b, { dkLen: 32 }));

export interface TransactionParts {
  bytes: Uint8Array;
  transaction: CborArray;
  body: CborMap;
  bodyBytes: Uint8Array;
  // Raw auxiliary data bytes, or null when the transaction carries none.
  auxiliary: Uint8Array | null;
}
// A Conway transaction: [body, witness set, is_valid, auxiliary data | null]; the 3-element pre-Alonzo form is accepted.
export function transactionParts(txHex: string): TransactionParts {
  const bytes = unhex(txHex);
  const transaction = decodeCborAll(bytes).value;
  if (!isCborArray(transaction) || (transaction.length !== 4 && transaction.length !== 3))
    throw new Error('Not a transaction');
  const body = transaction[0];
  if (!isCborMap(body)) throw new Error('Transaction body is not a map');
  // Auxiliary data is the last element in both forms (pre-Alonzo transactions have no is_valid flag).
  const auxIndex = transaction.length - 1;
  const auxiliary = transaction[auxIndex] === null ? null : bytes.subarray(...transaction.spans[auxIndex]);
  return { bytes, transaction, body, bodyBytes: bytes.subarray(...transaction.spans[0]), auxiliary };
}
// The transaction id: blake2b-256 over the body bytes exactly as they appear in the transaction.
export function transactionHash(txHex: string): string {
  return blake2b256(transactionParts(txHex).bodyBytes);
}
// Body field 7 (declared) against blake2b-256 of the raw auxiliary data bytes (computed).
export function auxiliaryDataHash(txHex: string): { computed: string | null; declared: string | null } {
  const { body, auxiliary } = transactionParts(txHex);
  const declared = body.get(7);
  return {
    computed: auxiliary ? blake2b256(auxiliary) : null,
    declared: declared instanceof Uint8Array ? hex(declared) : null,
  };
}
// The metadata map inside auxiliary data: Shelley (a bare map), Shelley-MA ([map, scripts]) or Alonzo+ (tag 259).
export function auxiliaryMetadata(auxiliary: Uint8Array): CborMap | null {
  const aux = decodeCborAll(auxiliary).value;
  if (isCborMap(aux)) return aux;
  if (isCborArray(aux)) return isCborMap(aux[0]) ? aux[0] : null;
  if (isCborTag(aux) && aux.tag === 259 && isCborMap(aux.value)) {
    const metadata = aux.value.get(0);
    return isCborMap(metadata) ? metadata : null;
  }
  return null;
}
