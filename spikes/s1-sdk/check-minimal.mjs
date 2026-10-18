import fs from 'node:fs';
const m = await import('./options/minimal.mjs'); const v = JSON.parse(fs.readFileSync(new URL('fixtures/vectors.json', import.meta.url)));
for (const t of v.txs) console.log(t.txHash === m.txHash(t.cbor), m.txHash(t.mutatedBody) !== t.txHash, JSON.stringify(m.auxHash(t.cbor)), m.auxHash(t.mutatedAux).computed !== t.declaredAux, JSON.stringify(m.commitmentFields(t.cbor), (k, x) => typeof x === 'bigint' ? String(x) : x));
for (const c of v.vectors) { const r = m.verifyCose(c, c.payload, c.address); if (r !== c.expect) console.log('MISMATCH', c.id, r); }
console.log('cose checked', v.vectors.length);
