// PD6-B: hand-written CBOR reader that keeps raw byte ranges, @noble/hashes and @noble/curves only.
import { blake2b } from '@noble/hashes/blake2.js';
import { ed25519 } from '@noble/curves/ed25519.js';

export const name = 'minimal';
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const fromHex = s => { if (!/^([0-9a-f]{2})*$/i.test(s)) throw new Error('bad hex'); return Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16)); };
const b256 = b => blake2b(b, { dkLen: 32 });
const b224 = b => blake2b(b, { dkLen: 28 });

// Decodes one item at pos. Returns { value, start, end }; maps become Map, tags { tag, value }, ints bigint.
export function read(bytes, pos = 0, depth = 0) {
  if (depth > 64) throw new Error('CBOR nesting too deep');
  const start = pos;
  if (pos >= bytes.length) throw new Error('CBOR truncated');
  const ib = bytes[pos++], major = ib >> 5, info = ib & 31;
  const arg = () => {
    if (info < 24) return BigInt(info);
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (n < 0 || pos + n > bytes.length) throw new Error('CBOR bad length');
    let v = 0n; for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(bytes[pos++]); return v;
  };
  const len = () => { const v = arg(); if (v > BigInt(bytes.length)) throw new Error('CBOR length exceeds input'); return Number(v); };
  const chunks = m => { // indefinite byte/text string
    const parts = [];
    while (bytes[pos] !== 0xff) { const c = read(bytes, pos, depth + 1); if ((bytes[pos] >> 5) !== m) throw new Error('CBOR bad chunk'); parts.push(c.value); pos = c.end; }
    pos++; return parts;
  };
  let value;
  switch (major) {
    case 0: value = arg(); break;
    case 1: value = -1n - arg(); break;
    case 2: if (info === 31) { const p = chunks(2); value = new Uint8Array(p.reduce((a, c) => [...a, ...c], [])); }
      else { const n = len(); if (pos + n > bytes.length) throw new Error('CBOR truncated'); value = bytes.slice(pos, pos + n); pos += n; } break;
    case 3: if (info === 31) value = chunks(3).join('');
      else { const n = len(); if (pos + n > bytes.length) throw new Error('CBOR truncated'); value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(pos, pos + n)); pos += n; } break;
    case 4: { value = []; value.spans = [];
      const n = info === 31 ? Infinity : len();
      for (let i = 0; i < n && !(info === 31 && bytes[pos] === 0xff); i++) { const c = read(bytes, pos, depth + 1); value.push(c.value); value.spans.push([c.start, c.end]); pos = c.end; }
      if (info === 31) pos++; break; }
    case 5: { value = new Map(); value.spans = new Map();
      const n = info === 31 ? Infinity : len();
      for (let i = 0; i < n && !(info === 31 && bytes[pos] === 0xff); i++) {
        const k = read(bytes, pos, depth + 1); const v = read(bytes, k.end, depth + 1);
        const key = typeof k.value === 'bigint' ? Number(k.value) : k.value;
        if (value.has(key)) throw new Error('CBOR duplicate map key');
        value.set(key, v.value); value.spans.set(key, [v.start, v.end]); pos = v.end;
      }
      if (info === 31) pos++; break; }
    case 6: { const tag = arg(); const c = read(bytes, pos, depth + 1); value = { tag: Number(tag), value: c.value, span: [c.start, c.end] }; pos = c.end; break; }
    case 7: value = info === 20 ? false : info === 21 ? true : info === 22 ? null : info === 23 ? undefined : (() => { throw new Error('CBOR float/simple unsupported'); })(); break;
  }
  return { value, start, end: pos };
}
export const readAll = bytes => { const r = read(bytes); if (r.end !== bytes.length) throw new Error('CBOR trailing bytes'); return r; };

export function txParts(txHex) {
  const bytes = fromHex(txHex);
  const tx = readAll(bytes).value;
  if (!Array.isArray(tx) || (tx.length !== 4 && tx.length !== 3)) throw new Error('not a transaction');
  if (!(tx[0] instanceof Map)) throw new Error('body is not a map');
  const [bs, be] = tx.spans[0];
  const aux = tx.length === 4 && tx[3] !== null ? bytes.subarray(...tx.spans[3]) : null;
  return { bytes, body: tx[0], bodyBytes: bytes.subarray(bs, be), aux };
}
export function txHash(txHex) { return hex(b256(txParts(txHex).bodyBytes)); }
export function auxHash(txHex) {
  const { body, aux } = txParts(txHex);
  return { computed: aux ? hex(b256(aux)) : null, declared: body.has(7) ? hex(body.get(7)) : null };
}
// Fields the protocol reads: invalid_hereafter (3), required_signers (14), metadata label map.
export function commitmentFields(txHex) {
  const { body, aux } = txParts(txHex);
  const signers = body.get(14); const list = signers?.tag === 258 ? signers.value : signers;
  let metadata = null;
  if (aux) { const a = read(aux).value; metadata = a instanceof Map ? a : a?.tag === 259 ? a.value.get(0) : Array.isArray(a) ? a[0] : null; }
  return { ttl: body.has(3) ? body.get(3) : null, requiredSigners: (list ?? []).map(hex), metadataLabels: metadata ? [...metadata.keys()] : [] };
}

// Minimal CBOR encoder for Sig_structure: ["Signature1", protected, external_aad, payload].
const head = (major, n) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : n < 65536 ? [major << 5 | 25, n >> 8, n & 255] : [major << 5 | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const bstr = b => [...head(2, b.length), ...b];
const tstr = s => { const b = new TextEncoder().encode(s); return [...head(3, b.length), ...b]; };
export const sigStructure = (protectedBytes, payload) => Uint8Array.from([...head(4, 4), ...tstr('Signature1'), ...bstr(protectedBytes), ...bstr(new Uint8Array()), ...bstr(payload)]);

// Credential that a CIP-30 signData signer must control: payment key for base/enterprise, stake key for reward.
export function signingKeyHash(addressBytes) {
  const type = addressBytes[0] >> 4;
  if ([0, 2, 4, 6].includes(type)) return hex(addressBytes.subarray(1, 29));
  if (type === 14) return hex(addressBytes.subarray(1, 29));
  throw new Error('address credential is not a key hash');
}
// CIP-8 / CIP-30 DataSignature check. Rejects hashed payloads (the protocol never asks for them).
export function verifyCose({ signature, key }, payloadHex, addressHex) {
  try {
    let s = readAll(fromHex(signature)).value; if (s?.tag === 18) s = s.value;
    if (!Array.isArray(s) || s.length !== 4) return false;
    const [protectedBytes, unprotected, payload, sig] = s;
    if (!(protectedBytes instanceof Uint8Array) || !(unprotected instanceof Map) || !(sig instanceof Uint8Array) || sig.length !== 64) return false;
    if (unprotected.get('hashed') === true) return false;
    const prot = readAll(protectedBytes).value;
    if (!(prot instanceof Map) || prot.get(1) !== -8n) return false;
    const addr = prot.get('address');
    if (!(addr instanceof Uint8Array) || hex(addr) !== addressHex.toLowerCase()) return false;
    if (!(payload instanceof Uint8Array) || hex(payload) !== payloadHex.toLowerCase()) return false;
    const k = readAll(fromHex(key)).value;
    if (!(k instanceof Map) || k.get(1) !== 1n || k.get(-1) !== 6n || (k.has(3) && k.get(3) !== -8n)) return false;
    const pub = k.get(-2); if (!(pub instanceof Uint8Array) || pub.length !== 32) return false;
    if (hex(b224(pub)) !== signingKeyHash(addr)) return false;
    return ed25519.verify(sig, sigStructure(protectedBytes, payload), pub, { zip215: false });
  } catch { return false; }
}
