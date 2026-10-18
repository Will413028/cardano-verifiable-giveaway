// Runs entries/rt-<option>.mjs in Chrome (GIVEAWAY_PLAYWRIGHT_MODULE, GIVEAWAY_CHROME_PATH) and in workerd (Miniflare).
// Each runtime tries the smallest bundle variant first and escalates only when the run fails. Writes results/runtime.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { Miniflare } from 'miniflare';
import { ladder } from './bundle.mjs';

const root = path.dirname(new URL(import.meta.url).pathname);
const only = process.argv.slice(2);
const options = only.length ? only : ['minimal', 'evolution', 'mesh', 'blaze'];
const passed = r => r && !r.fatal && r.verify?.ok === true && (r.build === null || r.build?.ok === true);

const server = http.createServer((req, res) => {
  const file = path.join(root, 'dist', decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(path.join(root, 'dist')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type }).end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const { chromium } = await import(process.env.GIVEAWAY_PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: process.env.GIVEAWAY_CHROME_PATH, headless: true, timeout: 60000 });
const chromeVersion = browser.version();

async function inChrome(dir) {
  fs.writeFileSync(path.join(root, 'dist', dir, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="browser-main.js"></script>');
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}/${dir}/index.html`);
  try { await page.waitForFunction(() => window.__result, null, { timeout: 120000 }); } catch { /* reported below */ }
  const result = await page.evaluate(() => window.__result ?? null);
  await page.close();
  return result ?? { fatal: `no result; page errors: ${errors.join(' | ')}` };
}
async function inWorkerd(file, compatibilityFlags) {
  let mf;
  try {
    mf = new Miniflare({ modules: true, scriptPath: file, compatibilityDate: '2026-07-01', compatibilityFlags, log: undefined });
    await mf.ready;
    const text = await (await mf.dispatchFetch('http://spike/')).text();
    try { return JSON.parse(text); } catch { return { fatal: text.slice(0, 400) }; }
  } catch (e) { return { fatal: String(e?.message ?? e).slice(0, 300) }; }
  finally { await mf?.dispose().catch(() => {}); }
}

const report = { chrome: chromeVersion, workerd: 'miniflare 4.20260730.0, compatibilityDate 2026-07-01', options: {} };
for (const n of options) {
  const rt = { RT: `${root}/entries/rt-${n}.mjs` };
  const out = report.options[n] = { chrome: [], workerd: [] };
  for (const step of await ladder('entries/browser-main.mjs', `dist/rt/${n}/chrome`, { baseAlias: rt })) {
    if (!step.ok) { out.chrome.push({ variant: step.variant, build: step }); continue; }
    const r = await inChrome(`rt/${n}/chrome/${step.variant}`);
    out.chrome.push({ variant: step.variant, raw: step.raw, gzip: step.gzip, shims: step.shims, empties: step.empties, globals: step.globals, passed: passed(r), result: r });
    if (passed(r)) break;
  }
  const rtv = { RT: `${root}/entries/rtv-${n}.mjs` };
  const workerSteps = await ladder('entries/worker-main.mjs', `dist/rt/${n}/workerd`, { baseAlias: rtv, splitting: false, conditions: ['workerd', 'worker', 'browser'] });
  for (const step of workerSteps) {
    if (!step.ok) { out.workerd.push({ variant: step.variant, build: step }); continue; }
    const r = await inWorkerd(`${root}/dist/rt/${n}/workerd/${step.variant}/worker-main.js`, []);
    out.workerd.push({ variant: step.variant, raw: step.raw, gzip: step.gzip, shims: step.shims, empties: step.empties, globals: step.globals, passed: passed(r), result: r });
    if (passed(r)) break;
  }
  if (!out.workerd.some(x => x.passed)) { // last resort: the platform's Node compatibility layer instead of browser shims
    const external = builtinModules.flatMap(m => [m, `node:${m}`]);
    // esbuild turns require() of an external into a throwing stub in ESM output; give the bundle a real require.
    const [step] = await ladder('entries/worker-main.mjs', `dist/rt/${n}/workerd-nodecompat`, { baseAlias: rtv, splitting: false, conditions: ['workerd', 'worker', 'browser'], external,
      banner: "import { createRequire as __cr } from 'node:module'; const require = __cr('/');" });
    const r = step.ok ? await inWorkerd(`${root}/dist/rt/${n}/workerd-nodecompat/bare/worker-main.js`, ['nodejs_compat']) : { fatal: JSON.stringify(step) };
    out.workerd.push({ variant: 'nodejs_compat', raw: step.raw, gzip: step.gzip, passed: passed(r), result: r });
  }
  const last = a => a.at(-1);
  console.log(n.padEnd(10), 'chrome', last(out.chrome).variant, last(out.chrome).passed ?? 'build-fail', '| workerd', last(out.workerd).variant, last(out.workerd).passed ?? 'build-fail');
}
await browser.close(); server.close();
fs.mkdirSync(`${root}/results`, { recursive: true });
const target = `${root}/results/runtime${only.length ? '-' + only.join('-') : ''}.json`;
fs.writeFileSync(target, JSON.stringify(report, null, 1).replaceAll(`file://${root}`, '.').replaceAll(root, '.')); // no local paths in committed results
console.log('wrote', path.relative(root, target));
