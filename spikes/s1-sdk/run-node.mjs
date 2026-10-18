import fs from 'node:fs';
import { run } from './harness.mjs';
const data = JSON.parse(fs.readFileSync(new URL('fixtures/vectors.json', import.meta.url)));
const results = [];
for (const n of process.argv.slice(2).length ? process.argv.slice(2) : ['minimal', 'evolution', 'mesh', 'blaze']) {
  const opt = await import(`./options/${n}.mjs`);
  results.push(await run(opt, data));
}
fs.mkdirSync(new URL('results/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('results/node.json', import.meta.url), JSON.stringify({ runtime: `node ${process.version}`, results }, null, 1));
for (const r of results) console.log(r.option, r.ok ? 'OK' : 'FAIL', JSON.stringify(r.txs), JSON.stringify(r.cose), r.coseUnwrapped ? 'unwrapped ' + JSON.stringify(r.coseUnwrapped) : '');
