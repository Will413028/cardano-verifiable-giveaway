// Mesh with only resolveTxHash imported: tree shaking leaves libsodium out, so the Worker starts.
import { resolveTxHash } from '@meshsdk/core';
import data from '../fixtures/vectors.json';
export default { async fetch() {
  try { return Response.json(data.txs.map(t => resolveTxHash(t.cbor) === t.txHash && resolveTxHash(t.mutatedBody) !== t.txHash)); }
  catch (e) { return Response.json({ error: String(e).slice(0, 300) }); }
} };
