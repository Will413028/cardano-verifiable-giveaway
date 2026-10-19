import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handle } from '../src/index.ts';

// Types `exports` from the main module; `wrangler types` would generate the same declaration.
declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import('../src/index.ts');
    }
  }
}

const PAGE = 'http://127.0.0.1:4320';
const env = { ALLOWED_ORIGIN: PAGE };
const from = (origin: string | null, init: RequestInit = {}, url = 'http://api.test/anything') =>
  new Request(url, { ...init, headers: { ...(origin ? { Origin: origin } : {}), ...(init.headers ?? {}) } });

afterEach(() => vi.restoreAllMocks());

describe('CORS (BR-04)', () => {
  it('refuses a page on another origin, preflight and request alike, without a CORS header', () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1:4321', 'null'])
      for (const method of ['OPTIONS', 'GET']) {
        const response = handle(from(origin, { method }), env);
        expect([origin, method, response.status]).toEqual([origin, method, 403]);
        expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      }
  });

  it('allows only the configured origin and names it, never *', () => {
    const preflight = handle(from(PAGE, { method: 'OPTIONS' }), env);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(PAGE);
    expect(preflight.headers.get('Vary')).toBe('Origin');
    const get = handle(from(PAGE), env);
    expect(get.headers.get('Access-Control-Allow-Origin')).toBe(PAGE);
  });

  it('refuses every browser origin when the configured origin is missing or malformed', () => {
    for (const configured of [{}, { ALLOWED_ORIGIN: '' }, { ALLOWED_ORIGIN: 'not a url' }]) {
      const response = handle(from(PAGE, { method: 'OPTIONS' }), configured);
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('sends no CORS header to a request without Origin (not a cross-origin page)', () => {
    const response = handle(from(null), env);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers the preflight with the origin configured in wrangler.jsonc', async () => {
    const response = await exports.default.fetch(from(PAGE, { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PAGE);
    const refused = await exports.default.fetch(from('https://evil.example', { method: 'OPTIONS' }));
    expect(refused.status).toBe(403);
  });
});

// PD8 A: the page reads the project Dolos directly; the backend has no route that reaches an indexer.
describe('no indexer forwarding (BR-01)', () => {
  it('answers 404 for the former /tip and Blockfrost paths without any outbound request', async () => {
    const outbound = vi.spyOn(globalThis, 'fetch');
    for (const path of ['/tip', '/blocks/latest', '/txs/00/cbor', '/tx/submit']) {
      const response = await exports.default.fetch(from(PAGE, {}, `http://api.test${path}`));
      expect([path, response.status]).toEqual([path, 404]);
    }
    expect(outbound).not.toHaveBeenCalled();
  });
});

// BR-05: request content (query, body, headers, client address) never reaches a log. Workers Logs are disabled in
// wrangler.jsonc (tests/core.test.mjs); here every console method is watched while requests carrying a marker
// in each part go through the wired worker.
describe('no request content in logs (BR-05)', () => {
  it('writes nothing to the console for any request', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
    const spies = methods.map((m) => vi.spyOn(console, m));
    const marker = 'MARKER-6f1c2a';
    const requests = [
      from(PAGE, {}, `http://api.test/tip?q=${marker}`),
      from(PAGE, { method: 'POST', body: marker }, 'http://api.test/bundles'),
      from(PAGE, { headers: { Authorization: marker, 'CF-Connecting-IP': '203.0.113.7' } }),
      from(`https://${marker}.example`, { method: 'OPTIONS' }),
      from(null, { method: 'PUT', body: marker }, `http://api.test/${marker}`),
    ];
    for (const request of requests) await exports.default.fetch(request);
    const logged = spies.flatMap((s) => s.mock.calls).map((args) => JSON.stringify(args));
    expect(logged.filter((line) => line.includes(marker) || line.includes('203.0.113.7'))).toEqual([]);
    expect(logged).toEqual([]);
  });
});
