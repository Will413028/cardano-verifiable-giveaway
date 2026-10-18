import * as opt from '../options/mesh.mjs';
import data from '../fixtures/vectors.json';
export default { async fetch(req) {
  const step = new URL(req.url).pathname.slice(1); const t = data.txs[0]; const v = data.vectors[0];
  try {
    if (step === 'hash') return Response.json({ ok: opt.txHash(t.cbor) === t.txHash });
    if (step === 'aux') return Response.json(opt.auxHash(t.cbor));
    if (step === 'cose') return Response.json({ id: v.id, got: await Promise.race([opt.verifyCose(v, v.payload, v.address), new Promise(r => setTimeout(() => r('timeout'), 5000))]) });
  } catch (e) { return Response.json({ error: String(e).slice(0, 300) }); }
} };
