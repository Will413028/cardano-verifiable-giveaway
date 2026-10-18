import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
// The convenience backend (apps/api) is reached at an address fixed at build time. An empty or
// non-HTTP value fails the build instead of shipping a page that requests a broken URL.
const apiUrl = new URL(process.env.GIVEAWAY_API_URL ?? 'http://127.0.0.1:8787');
if (
  !['http:', 'https:'].includes(apiUrl.protocol) ||
  apiUrl.username ||
  apiUrl.password ||
  apiUrl.search ||
  apiUrl.hash
)
  throw new Error('GIVEAWAY_API_URL must be an http(s) URL without credentials, query or fragment');
await mkdir(`${root}dist`, { recursive: true });
await build({
  entryPoints: [`${root}apps/web/app.ts`],
  // Aliases and the injected shim resolve from the web package, which declares them.
  absWorkingDir: `${root}apps/web`,
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
  define: { global: 'globalThis', GIVEAWAY_API_URL: JSON.stringify(apiUrl.href.replace(/\/$/, '')) },
  inject: [`${root}apps/web/polyfills.js`],
});
await build({
  entryPoints: [`${root}apps/verifier-cli/library.ts`],
  absWorkingDir: `${root}apps/verifier-cli`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: `${root}apps/verifier-cli/dist/library.mjs`,
});
for (const name of ['index.html', 'styles.css']) await copyFile(`${root}apps/web/${name}`, `${root}dist/${name}`);
console.log('Built static web app and independent Node verifier library');
