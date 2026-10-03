import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/dist/wallet.js', ['dist/wallet.js', 'text/javascript; charset=utf-8']],
]);
const server = createServer(async (req, res) => {
  let route = routes.get(req.url);
  if (!route && /^\/dist\/[A-Za-z0-9_-]+\.(js|wasm)$/.test(req.url)) {
    route = [req.url.slice(1), req.url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8'];
  }
  if (req.method !== 'GET' || !route) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const body = await readFile(new URL(route[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' }); res.end(body);
  } catch { res.writeHead(503); res.end('Browser bundle is not built yet. See spike-a.md.'); }
});
server.listen(4310, '127.0.0.1', () => console.log('http://127.0.0.1:4310 — preprod spike only'));
