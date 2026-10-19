// Convenience backend entry (ADR 2026-10-18-typescript-convenience-backend). It forwards nothing to the indexer: since
// PD8 A the page reads the project Dolos directly, through the reverse proxy in deploy/dolos-proxy/ (BR-01). Bundle
// hosting (plan step 10) is the first route; owner operations (11) and drafts (12) add theirs here. It never signs,
// submits, generates randomness or decides PASS/FAIL (B2), and verification never depends on it (B1).
//
// BR-05: no request content is logged. Nothing here writes to the console, and wrangler.jsonc keeps Workers
// observability (invocation logs, which record request URLs) disabled.

import { BlockfrostChain } from '@giveaway/chain';
import { type HostingChain, type HostingEnv, HttpError, read, reconcile, sweep, upload } from './bundles.ts';

export interface Env extends HostingEnv {
  // The one browser origin allowed to call the backend (BR-04): the page's own.
  ALLOWED_ORIGIN?: string;
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

const BUNDLE_ROUTE = /^\/bundles\/([^/]+)$/;

export async function handle(request: Request, env: Env, deps: Partial<Deps> = {}): Promise<Response> {
  const { now, chain } = { ...defaults, ...deps };
  const allowed = allowedOrigin(env);
  const origin = request.headers.get('Origin');
  // BR-04: a browser on any other origin is refused before routing; requests without an Origin header are not from a
  // cross-origin page and get no CORS header.
  if (origin !== null && origin !== allowed) return reply(403, 'Origin not allowed', { Vary: 'Origin' });
  const cors: Record<string, string> = origin === null ? {} : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  const route = BUNDLE_ROUTE.exec(new URL(request.url).pathname);
  if (request.method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, PUT', 'Access-Control-Allow-Headers': 'Content-Type' },
    });
  if (!route) return reply(404, 'Not found', cors);
  const txHash = route[1];
  try {
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
      const { status, hosted } = await upload(env, chain(env), txHash, request, now());
      return Response.json(hosted, { status, headers: cors });
    }
    return reply(405, 'Method not allowed', { ...cors, Allow: 'GET, PUT, OPTIONS' });
  } catch (e) {
    if (e instanceof HttpError) return reply(e.status, e.message, cors);
    // Nothing about the request or the failure is logged (BR-05).
    return reply(500, 'Internal error', cors);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
  // Cron Trigger (wrangler.jsonc): expired records and their unreferenced bytes are removed (BR-08), then bytes no
  // record names are reconciled (apps/api/src/bundles.ts, "Writing and deleting bytes").
  scheduled: async (controller, env) => {
    const now = Math.floor(controller.scheduledTime / 1000);
    await sweep(env, now);
    await reconcile(env, now);
  },
} satisfies ExportedHandler<Env>;
