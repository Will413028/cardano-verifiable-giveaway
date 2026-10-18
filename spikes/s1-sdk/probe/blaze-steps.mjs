import * as Core from '@blaze-cardano/core';
import data from '../fixtures/vectors.json';
export default { async fetch(req) {
  const step = new URL(req.url).pathname.slice(1); const t = data.txs[0];
  try {
    if (step === 'hash') return Response.json({ ok: Core.Transaction.fromCbor(Core.TxCBOR(t.cbor)).getId() === t.txHash });
    if (step === 'aux') { const opt = await import('../options/blaze.mjs'); return Response.json(data.txs.map(x => opt.auxHash(x.cbor).computed === x.declaredAux && opt.auxHash(x.mutatedAux).computed !== x.declaredAux)); }
    if (step === 'hashAll') { const opt = await import('../options/blaze.mjs'); return Response.json(data.txs.map(x => opt.txHash(x.cbor) === x.txHash && opt.txHash(x.mutatedBody) !== x.txHash)); }
    if (step === 'blake') return Response.json({ v: Core.blake2b_256(Core.HexBlob('00')) });
    if (step === 'init') { await Core.initCrypto(); return Response.json({ ok: true }); }
    if (step === 'wasm') { try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return Response.json({ ok: true }); } catch (e) { return Response.json({ wasmError: String(e) }); } }
    if (step === 'verify') { const opt = await import('../options/blaze.mjs'); const v = data.vectors[0]; return Response.json({ id: v.id, got: opt.verifyCose(v, v.payload, v.address) }); }
    if (step === 'edraw') { const v = data.vectors[0]; try { Core.Ed25519PublicKey.fromHex(Core.Ed25519PublicKeyHex('ab'.repeat(32))).verify(Core.Ed25519Signature.fromHex(Core.Ed25519SignatureHex('00'.repeat(64))), Core.HexBlob('00')); return Response.json({ ok: 'no throw' }); } catch (e) { return Response.json({ error: String(e).slice(0, 300) }); } }
    if (step === 'ed') { const v = data.vectors[0]; return Response.json({ v: typeof Core.Ed25519PublicKey.fromHex(Core.Ed25519PublicKeyHex('ab'.repeat(32))) }); }
  } catch (e) { return Response.json({ error: String(e?.stack ?? e).slice(0, 600) }); }
  return new Response('?');
} };
