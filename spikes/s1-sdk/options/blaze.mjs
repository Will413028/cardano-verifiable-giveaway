// Blaze 0.3.3 / core 0.10.1. Transaction parsing comes from @cardano-sdk/core. Blaze has no CIP-8 verifier:
// COSE structure parsing is the minimal option's code; ed25519 and blake2b-224 are Blaze's (libsodium) primitives.
import * as Core from '@blaze-cardano/core';
import { readAll, fromHex, sigStructure, signingKeyHash } from './minimal.mjs';

export const name = 'blaze';
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const init = () => Core.initCrypto?.();
export const txHash = txHex => Core.Transaction.fromCbor(Core.TxCBOR(txHex)).getId();
export function auxHash(txHex) {
  const tx = Core.Transaction.fromCbor(Core.TxCBOR(txHex));
  const aux = tx.auxiliaryData();
  return { computed: aux ? Core.blake2b_256(aux.toCbor()) : null, declared: tx.body().auxiliaryDataHash() ?? null };
}
// Same structural checks as minimal.verifyCose; only the ed25519 and blake2b-224 calls differ.
export function verifyCose({ signature, key }, payloadHex, addressHex) {
  try {
    let s = readAll(fromHex(signature)).value; if (s?.tag === 18) s = s.value;
    if (!Array.isArray(s) || s.length !== 4) return false;
    const [prot, unprot, payload, sig] = s;
    if (!(prot instanceof Uint8Array) || !(unprot instanceof Map) || !(sig instanceof Uint8Array) || sig.length !== 64) return false;
    if (unprot.get('hashed') === true) return false;
    const p = readAll(prot).value; const addr = p instanceof Map ? p.get('address') : undefined;
    if (p.get(1) !== -8n || !(addr instanceof Uint8Array) || hex(addr) !== addressHex.toLowerCase()) return false;
    if (!(payload instanceof Uint8Array) || hex(payload) !== payloadHex.toLowerCase()) return false;
    const k = readAll(fromHex(key)).value;
    if (!(k instanceof Map) || k.get(1) !== 1n || k.get(-1) !== 6n || (k.has(3) && k.get(3) !== -8n)) return false;
    const pub = k.get(-2); if (!(pub instanceof Uint8Array) || pub.length !== 32) return false;
    if (Core.blake2b_224(Core.HexBlob(hex(pub))) !== signingKeyHash(addr)) return false;
    return Core.Ed25519PublicKey.fromHex(Core.Ed25519PublicKeyHex(hex(pub)))
      .verify(Core.Ed25519Signature.fromHex(Core.Ed25519SignatureHex(hex(sig))), Core.HexBlob(hex(sigStructure(prot, payload))));
  } catch { return false; }
}
