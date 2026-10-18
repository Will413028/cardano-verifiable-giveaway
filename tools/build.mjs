import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}dist`, { recursive: true });
await build({
  entryPoints: [`${root}apps/web/app.ts`],
  absWorkingDir: root,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outdir: `${root}dist`,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  minify: true,
  sourcemap: false,
  // Mesh's dynamically loaded browser integration needs the same standard shims measured in Spike A.
  alias: {
    crypto: 'crypto-browserify',
    stream: 'stream-browserify',
    events: 'events',
    buffer: 'buffer',
    process: 'process',
  },
  define: { global: 'globalThis' },
  inject: [`${root}tools/polyfills.js`],
});
await build({
  stdin: {
    contents:
      "export * from './packages/protocol/index.ts'; export * from './packages/beacon/index.ts'; export * from './packages/chain/index.ts'; export * from './packages/protocol/verifier.ts';",
    resolveDir: root,
  },
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: `${root}dist/library.mjs`,
});
for (const name of ['index.html', 'styles.css']) await copyFile(`${root}apps/web/${name}`, `${root}dist/${name}`);
console.log('Built static web app and independent Node verifier library');
