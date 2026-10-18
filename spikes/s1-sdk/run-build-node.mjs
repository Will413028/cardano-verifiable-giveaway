import fs from 'node:fs';
import { checkBuild } from './build-check.mjs';
const { buildSpec } = JSON.parse(fs.readFileSync(new URL('fixtures/vectors.json', import.meta.url)));
const results = [];
for (const n of ['mesh', 'evolution', 'blaze']) results.push(await checkBuild(await import(`./build/${n}.mjs`), buildSpec));
fs.mkdirSync(new URL('results/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('results/build-node.json', import.meta.url), JSON.stringify({ runtime: `node ${process.version}`, results }, null, 1));
for (const r of results) console.log(JSON.stringify(r));
