import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
const port = Number(process.env.PORT ?? 4320);
const root = new URL('../dist/', import.meta.url);
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method !== 'GET' || (path !== '/' && !/^\/(?:chunks\/)?[a-zA-Z0-9_.-]+\.(html|css|js)$/.test(path))) {
    res.writeHead(404); res.end('Not found'); return;
  }
  try {
    const name = path === '/' ? 'index.html' : path.slice(1);
    const body = await readFile(new URL(name, root));
    const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[extname(name)];
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body);
  } catch { res.writeHead(404); res.end('Run the build command first'); }
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));
