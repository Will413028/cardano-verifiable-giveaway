// Bundles each entry for the browser (and workerd) with the fewest shims that let esbuild resolve it.
// Usage: node bundle.mjs [size|runtime]. Writes results/bundles.json and dist/.
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
const SHIMS = { crypto: 'crypto-browserify', stream: 'stream-browserify', events: 'events', buffer: 'buffer', process: 'process' };
const builtins = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));

async function attempt(entry, outdir, { alias = {}, baseAlias = {}, inject = false, empties = [], platform = 'browser', conditions, external = [], splitting = true, banner }) {
  fs.rmSync(outdir, { recursive: true, force: true });
  const emptyPlugin = { name: 'empty', setup(b) {
    if (!empties.length) return;
    b.onResolve({ filter: new RegExp(`^(node:)?(${empties.map(e => e.replace(/[/]/g, '\\/')).join('|')})$`) }, () => ({ path: 'empty', namespace: 'empty' }));
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export default {}', loader: 'js' }));
  } };
  try {
    const r = await build({ entryPoints: [entry], absWorkingDir: root, bundle: true, splitting, format: 'esm', platform, target: 'es2022',
      outdir, minify: true, metafile: true, logLevel: 'silent', alias: { ...baseAlias, ...alias }, external, conditions, plugins: [emptyPlugin],
      define: Object.keys(alias).length || inject ? { global: 'globalThis' } : {}, inject: inject ? [`${root}/entries/polyfills.js`] : [],
      loader: { '.wasm': 'file' }, banner: banner ? { js: banner } : undefined });
    const files = Object.keys(r.metafile.outputs).map(f => path.join(root, f));
    const raw = files.reduce((a, f) => a + fs.statSync(f).size, 0);
    const gzip = files.reduce((a, f) => a + zlib.gzipSync(fs.readFileSync(f), { level: 9 }).length, 0);
    // Third-party packages that ended up in the output (trust-path size), from the metafile inputs.
    const packages = [...new Set(Object.keys(r.metafile.inputs).map(f => /node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*node_modules)/.exec(f)?.[1]).filter(Boolean))].sort();
    return { ok: true, files: files.length, raw, gzip, packageCount: packages.length, packages };
  } catch (e) {
    const unresolved = [...new Set((e.errors ?? []).map(x => /Could not resolve "([^"]+)"/.exec(x.text)?.[1]).filter(Boolean))];
    return { ok: false, unresolved, errors: (e.errors ?? []).slice(0, 3).map(x => x.text) };
  }
}
// Escalation: bare -> alias the unresolved Node built-ins (empty module when no browser shim exists) -> plus Buffer/process globals.
export async function ladder(entry, outBase, opts = {}) {
  const steps = [];
  const bare = await attempt(entry, `${outBase}/bare`, opts); steps.push({ variant: 'bare', ...bare });
  if (bare.ok) return steps;
  const missing = bare.unresolved.map(m => m.replace(/^node:/, ''));
  const nonBuiltin = bare.unresolved.filter(m => !builtins.has(m));
  if (nonBuiltin.length || !bare.unresolved.length) return steps;
  const alias = {}; const empties = [];
  for (const m of new Set(missing)) { const base = m.split('/')[0]; if (SHIMS[base] && m === base) { alias[m] = SHIMS[base]; alias[`node:${m}`] = SHIMS[base]; } else empties.push(m); }
  const a = await attempt(entry, `${outBase}/alias`, { ...opts, alias, empties }); steps.push({ variant: 'alias', shims: Object.keys(alias).filter(k => !k.startsWith('node:')), empties, ...a });
  const g = await attempt(entry, `${outBase}/alias-globals`, { ...opts, alias, empties, inject: true }); steps.push({ variant: 'alias-globals', shims: Object.keys(alias).filter(k => !k.startsWith('node:')), empties, globals: ['Buffer', 'process'], ...g });
  return steps;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const results = {};
  for (const n of ['minimal', 'evolution', 'mesh', 'blaze']) results[`verify-${n}`] = await ladder(`options/${n}.mjs`, `dist/size/verify-${n}`);
  for (const n of ['evolution', 'mesh', 'blaze']) results[`tx-${n}`] = await ladder(`entries/tx-${n}.mjs`, `dist/size/tx-${n}`);
  fs.mkdirSync(`${root}/results`, { recursive: true });
  fs.writeFileSync(`${root}/results/bundles.json`, JSON.stringify(results, null, 1));
  for (const [k, steps] of Object.entries(results)) for (const s of steps) console.log(k.padEnd(18), s.variant.padEnd(14), s.ok ? `${s.raw} / ${s.gzip} gz, ${s.files} files, ${s.packageCount} pkgs` : `FAIL ${JSON.stringify(s.unresolved ?? s.errors)}`, s.shims ? `shims=${s.shims} empties=${s.empties}` : '');
}
