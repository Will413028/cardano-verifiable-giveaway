import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { handle } from '../src/index.ts';
import type { Upstream } from '../src/proxy.ts';

// Types `exports` from the main module; `wrangler types` would generate the same declaration.
declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import('../src/index.ts');
    }
  }
}

const INDEXER = 'http://127.0.0.1:3010';
const env = { ALLOWED_ORIGIN: 'http://127.0.0.1:4320', INDEXER_URL: INDEXER };
// Dolos 1.6.1 /blocks/latest on the dev chain (docs/plans/2026-10-18-hardening-and-backend/dolos-1.6.1-captures.json).
const TIP =
  '{"time":1655683305,"height":105,"hash":"6b45ce48205f3e06a0009d977d1cc3e57bda90f594c2440a3dfd35ff278c16ff","slot":105,"epoch":0,"epoch_slot":105}';

// Records every upstream call so tests can assert what reached the indexer.
function recorder(response: () => Response | Promise<Response>) {
  const calls: { input: string; init: RequestInit }[] = [];
  const upstream: Upstream = async (input, init) => {
    calls.push({ input, init });
    return response();
  };
  return { calls, upstream };
}

describe('GET /tip', () => {
  it('forwards to the configured indexer /blocks/latest and passes the body bytes through', async () => {
    const { calls, upstream } = recorder(() => new Response(TIP, { headers: { 'Content-Type': 'application/json' } }));
    const response = await handle(new Request('http://api.test/tip'), env, upstream);
    expect(calls.map((c) => [c.input, c.init.method])).toEqual([[`${INDEXER}/blocks/latest`, 'GET']]);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(TIP);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:4320');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('passes an upstream error status through unchanged', async () => {
    const { upstream } = recorder(() => new Response('busy', { status: 429 }));
    const response = await handle(new Request('http://api.test/tip'), env, upstream);
    expect([response.status, await response.text()]).toEqual([429, 'busy']);
  });

  it('answers 502 when the indexer cannot be reached', async () => {
    const { upstream } = recorder(() => {
      throw new TypeError('network down');
    });
    const response = await handle(new Request('http://api.test/tip'), env, upstream);
    expect(response.status).toBe(502);
  });

  it('answers 502 without an upstream call when the indexer is not configured or not https', async () => {
    for (const configured of [
      { ALLOWED_ORIGIN: env.ALLOWED_ORIGIN },
      { ...env, INDEXER_URL: 'http://indexer.example' },
    ]) {
      const { calls, upstream } = recorder(() => new Response(TIP));
      const response = await handle(new Request('http://api.test/tip'), configured, upstream);
      expect(response.status).toBe(502);
      expect(calls).toEqual([]);
    }
  });
});

describe('refused requests never reach the indexer', () => {
  const cases: [string, RequestInit, number][] = [
    ['http://api.test/blocks', {}, 404],
    ['http://api.test/blocks/latest', {}, 404],
    ['http://api.test/', {}, 404],
    ['http://api.test/https://evil.test/x', {}, 404],
    ['http://api.test/tip', { method: 'POST', body: '{}' }, 405],
    ['http://api.test/tip?select=hash', {}, 400],
  ];
  for (const [url, init, status] of cases)
    it(`${init.method ?? 'GET'} ${url} → ${status}`, async () => {
      const { calls, upstream } = recorder(() => new Response(TIP));
      const response = await handle(new Request(url, init), env, upstream);
      expect(response.status).toBe(status);
      expect(calls).toEqual([]);
    });
});

describe('CORS', () => {
  it('omits the allow-origin header when the origin is missing or empty', async () => {
    for (const configured of [{}, { ALLOWED_ORIGIN: '' }, { ALLOWED_ORIGIN: 'not a url' }]) {
      const { upstream } = recorder(() => new Response(TIP));
      const response = await handle(new Request('http://api.test/tip'), configured, upstream);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('answers the preflight with the origin configured in wrangler.jsonc', async () => {
    const response = await exports.default.fetch(new Request('http://api.test/tip', { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:4320');
  });
});
