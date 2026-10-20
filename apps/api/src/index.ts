// Convenience backend entry (ADR 2026-10-18-typescript-convenience-backend). It forwards nothing to the indexer: since
// PD8 A the page reads the project Dolos directly, through the reverse proxy in deploy/dolos-proxy/ (BR-01). Routes:
// bundle hosting (plan step 10), signed by the owner since step 11, and the owner's deletion and extension (step 11,
// apps/api/src/owner.ts) with the nonce they sign (apps/api/src/auth.ts); drafts (12) add theirs here. It never signs,
// submits, generates randomness or decides PASS/FAIL (B2), and verification never depends on it (B1).
//
// BR-05: no request content is logged. Nothing here writes to the console, and wrangler.jsonc keeps Workers
// observability (invocation logs, which record request URLs) disabled.

import { BlockfrostChain } from '@giveaway/chain';
import { issueNonce } from './auth.ts';
import { type HostingChain, type HostingEnv, read, reconcile, sweep, upload } from './bundles.ts';
import { HttpError } from './http.ts';
import { extend, remove } from './owner.ts';

export interface Env extends HostingEnv {
  // The one browser origin allowed to call the backend (BR-04): the page's own. Its host is also the domain an owner
  // operation must be signed for (apps/api/src/auth.ts).
  ALLOWED_ORIGIN?: string;
  // Per-client-address limit of the write routes (wrangler.jsonc `ratelimits`; see `limited` below).
  WRITE_LIMIT: RateLimit;
}
// What tests replace: the clock (Unix seconds; expiry and Cron are tested with injected time) and the indexer reader.
export interface Deps {
  now: () => number;
  chain: (env: Env) => HostingChain;
}
const defaults: Deps = {
  now: () => Math.floor(Date.now() / 1000),
  chain: (env) => {
    if (!env.INDEXER_URL) throw new HttpError(503, 'Bundle hosting is not configured (no INDEXER_URL)');
    return new BlockfrostChain(env.INDEXER_URL);
  },
};

// The configured origin in canonical form, or null when it is missing or malformed: then every browser is refused
// rather than everyone allowed.
function allowedOrigin(env: Env): string | null {
  if (!env.ALLOWED_ORIGIN) return null;
  try {
    const origin = new URL(env.ALLOWED_ORIGIN).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

function reply(status: number, message: string, headers: Record<string, string>): Response {
  return new Response(message, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
}

const BUNDLE_ROUTE = /^\/bundles\/([^/]+)(\/extend)?$/;
const WRITES = new Set(['PUT', 'POST', 'DELETE']);

// Per-IP rate limiting of the write routes (plan step 11; ADR wallet-auth "濫用防護", Amendment 6): the Workers Rate
// Limiting binding, keyed by the client address Cloudflare puts in CF-Connecting-IP (a request without it, as a local
// one may be, shares one bucket). Necessity condition: a write request makes the Worker spend more than it costs its
// sender — up to BUNDLE_BYTE_LIMIT of hashing, canonical serialization and validateBundle (about 0.1 s CPU, PD2), an
// Ed25519 verification and up to eight reads of the project Dolos (commitmentOwner, readCommitment) — before the signer
// is known to be the owner: anyone can sign with a key of their own, so neither the owner quota nor the one-time nonce
// bounds the number of such requests. If no write route did costly work before the owner check (or an edge rule in
// front of the Worker took over the per-address limit), this binding would have no reason to exist. It counts per
// Cloudflare location and approximately (plan prerequisites), which bounds a single source, not a distributed one; it
// keeps the address only in its counter and nothing is written (BR-05). The nonce endpoint is not limited: it writes
// nothing and computes one HMAC (apps/api/src/auth.ts). The values in wrangler.jsonc are initial defaults (SELF-IMPOSED).
async function limited(request: Request, env: Env): Promise<boolean> {
  const { success } = await env.WRITE_LIMIT.limit({ key: clientKey(request.headers.get('CF-Connecting-IP')) });
  return !success;
}
// The limiter's key for a client address: an IPv4 address as it is, an IPv6 address by its /64 prefix (review M1: one
// subscriber usually holds a whole /64, so keying on the full address would hand out a fresh bucket per address).
export function clientKey(address: string | null): string {
  if (!address) return 'unknown';
  const text = address.trim().toLowerCase();
  if (!text.includes(':')) return text;
  // An IPv4 client written as IPv6 (::ffff:a.b.c.d) is keyed by its IPv4 address.
  if (text.includes('.')) return text.slice(text.lastIndexOf(':') + 1);
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups =
    tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':')}::/64`;
}

export async function handle(request: Request, env: Env, deps: Partial<Deps> = {}): Promise<Response> {
  const { now, chain } = { ...defaults, ...deps };
  const allowed = allowedOrigin(env);
  const origin = request.headers.get('Origin');
  // BR-04: a browser on any other origin is refused before routing; requests without an Origin header are not from a
  // cross-origin page and get no CORS header.
  if (origin !== null && origin !== allowed) return reply(403, 'Origin not allowed', { Vary: 'Origin' });
  const cors: Record<string, string> = origin === null ? {} : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  const path = new URL(request.url).pathname;
  const route = BUNDLE_ROUTE.exec(path);
  if (request.method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  const nonceRoute = path === '/nonce' && request.method === 'GET';
  if (!route && !nonceRoute) return reply(404, 'Not found', cors);
  const domain = allowed === null ? null : new URL(allowed).host;
  try {
    if (WRITES.has(request.method) && (await limited(request, env)))
      return reply(429, 'Too many write requests from this address; try again in a minute', {
        ...cors,
        'Retry-After': '60',
      });
    if (nonceRoute)
      return Response.json(await issueNonce(env.NONCE_KEY, now()), {
        headers: { ...cors, 'Cache-Control': 'no-store' },
      });
    if (!route) return reply(404, 'Not found', cors);
    const [, txHash, extendRoute] = route;
    if (extendRoute) {
      if (request.method !== 'POST') return reply(405, 'Method not allowed', { ...cors, Allow: 'POST, OPTIONS' });
      return Response.json(await extend(env, request, txHash, now(), domain), { headers: cors });
    }
    if (request.method === 'GET') {
      const { bytes, bundleHash } = await read(env, txHash, now());
      return new Response(bytes.body, {
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          // Expiry and takedown take effect on the next read; no copy outlives them in a cache.
          'Cache-Control': 'no-store',
          'X-Bundle-Hash': bundleHash,
          ...(origin === null ? {} : { 'Access-Control-Expose-Headers': 'X-Bundle-Hash' }),
        },
      });
    }
    if (request.method === 'PUT') {
      const { status, hosted } = await upload(env, chain(env), txHash, request, now(), domain);
      return Response.json(hosted, { status, headers: cors });
    }
    if (request.method === 'DELETE')
      return Response.json(await remove(env, request, txHash, now(), domain), { headers: cors });
    return reply(405, 'Method not allowed', { ...cors, Allow: 'GET, PUT, DELETE, OPTIONS' });
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, e.message, cors);
    // Nothing about the request or the failure is logged (BR-05).
    return reply(500, 'Internal error', cors);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
  // Cron Trigger (wrangler.jsonc): expired records and their unreferenced bytes are removed (BR-08), as are expired
  // nonce use records, then bytes no record names are reconciled (apps/api/src/bundles.ts, "Writing and deleting bytes").
  scheduled: async (controller, env) => {
    const now = Math.floor(controller.scheduledTime / 1000);
    await sweep(env, now);
    await reconcile(env, now);
  },
} satisfies ExportedHandler<Env>;
