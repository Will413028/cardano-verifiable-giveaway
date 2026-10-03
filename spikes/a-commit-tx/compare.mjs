import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { wasmPlugin } from './wasm-plugin.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
await mkdir(`${root}dist`, { recursive: true });
const entries = {
  mesh: "export { BrowserWallet, MeshTxBuilder, KoiosProvider, cst } from '@meshsdk/core';",
  lucid: "export { Lucid, CML } from '@lucid-evolution/lucid';",
};
const results = [];
for (const [sdk, contents] of Object.entries(entries)) {
  try {
    const result = await build({
      stdin: { contents, resolveDir: root, sourcefile: `${sdk}-entry.js` },
      absWorkingDir: root, bundle: true, minify: true, format: 'esm',
      platform: 'browser', target: 'es2022', write: false, metafile: true,
      outfile: `${root}dist/${sdk}.js`, loader: { '.wasm': 'file' },
      alias: { crypto: 'crypto-browserify', stream: 'stream-browserify', events: 'events',
        buffer: 'buffer', process: 'process' },
      inject: [`${root}polyfills.js`],
      define: { global: 'globalThis' },
      plugins: [wasmPlugin()],
      logLevel: 'silent',
    });
    let raw = 0, gzip = 0;
    for (const file of result.outputFiles) {
      await writeFile(file.path, file.contents);
      raw += file.contents.length;
      gzip += gzipSync(file.contents).length;
    }
    await writeFile(`${root}dist/${sdk}-metafile.json`, JSON.stringify(result.metafile, null, 2));
    results.push({ sdk, status: 'built', rawBytes: raw, gzipBytes: gzip,
      artifacts: result.outputFiles.map(f => ({ name: f.path.split('/').at(-1), bytes: f.contents.length })) });
  } catch (e) {
    results.push({ sdk, status: 'build-failed', errors: e.errors?.map(x => x.text) ?? [e.message] });
  }
}
const dependencies = JSON.parse(await readFile(`${root}package.json`, 'utf8')).dependencies;
const report = { timestamp: new Date().toISOString(), node: process.version,
  dependencies, conditions: 'esbuild browser ESM, minified, ES2022; exported transaction and wallet APIs; WASM counted separately; standard Node browser polyfills included', results };
await writeFile(`${root}dist/comparison.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (results.every(r => r.status !== 'built')) process.exitCode = 1;
try {
  await build({ entryPoints: [`${root}wallet.js`], absWorkingDir: root,
    bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2022',
    outfile: `${root}dist/wallet.js`, loader: { '.wasm': 'file' },
    alias: { crypto: 'crypto-browserify', stream: 'stream-browserify', events: 'events',
      buffer: 'buffer', process: 'process' }, inject: [`${root}polyfills.js`],
    define: { global: 'globalThis' },
    plugins: [wasmPlugin()],
  });
} catch (e) { console.error('Wallet bundle failed:', e.message); process.exitCode = 1; }
