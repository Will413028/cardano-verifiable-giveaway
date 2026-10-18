// Item-by-item workerd probes for the options whose full run fails there. Writes results/workerd-items.json.
// Usage: node probe/run.mjs
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import fs from 'node:fs';
const cases = [
  ['probe/blaze-steps.mjs', ['hashAll', 'aux', 'wasm', 'edraw', 'verify', 'init']],
  ['probe/mesh-hash-only.mjs', ['hash']],
  ['probe/mesh-option.mjs', ['hash', 'aux', 'cose']],
];
const out = {};
for (const [entry, steps] of cases) {
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'], outfile: 'probe/out.js',
    alias: { stream: 'stream-browserify', crypto: 'crypto-browserify' }, define: { global: 'globalThis' }, inject: ['entries/polyfills.js'], logLevel: 'error' });
  for (const s of steps) {
    let mf, r;
    try { mf = new Miniflare({ modules: true, scriptPath: 'probe/out.js', compatibilityDate: '2026-07-01' }); await mf.ready;
      r = (await (await mf.dispatchFetch(`http://p/${s}`)).text()).slice(0, 400); }
    catch (e) { r = `FATAL ${String(e.message).replace(/\s+/g, ' ').slice(0, 300)}`; }
    finally { await mf?.dispose().catch(() => {}); }
    out[`${entry} ${s}`] = r; console.log(entry, s, r);
  }
}
fs.writeFileSync('results/workerd-items.json', JSON.stringify(out, null, 1).replaceAll(`file://${process.cwd()}`, '.').replaceAll(process.cwd(), '.'));
