import { ENDPOINTS, forward, type Upstream } from './proxy.ts';

// Convenience backend entry. It never signs, submits, generates randomness or decides PASS/FAIL (B2),
// and verification never depends on it (B1).

export interface Env {
  ALLOWED_ORIGIN?: string;
  // The project's Blockfrost-compatible indexer (PD7: the project Dolos).
  INDEXER_URL?: string;
}

// A missing or malformed origin yields no CORS header, so browsers are refused rather than everyone allowed.
function corsHeaders(env: Env): Record<string, string> {
  if (!env.ALLOWED_ORIGIN) return {};
  let origin: string;
  try {
    origin = new URL(env.ALLOWED_ORIGIN).origin;
  } catch {
    return {};
  }
  return origin === 'null' ? {} : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

function reply(status: number, message: string, cors: Record<string, string>): Response {
  return new Response(message, { status, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function handle(request: Request, env: Env, upstream: Upstream): Promise<Response> {
  const cors = corsHeaders(env);
  const url = new URL(request.url);
  const endpoint = url.pathname.slice(1);
  if (!ENDPOINTS.has(endpoint)) return reply(404, 'Not found', cors);
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
  if (request.method !== 'GET') return reply(405, 'Method not allowed', { ...cors, Allow: 'GET' });
  // The skeleton forwards no query parameters (Blockfrost paging, filters), so it refuses them.
  if (url.search) return reply(400, 'Query parameters are not accepted', cors);
  let response: Response;
  try {
    response = await forward(endpoint, upstream, env.INDEXER_URL ?? '');
  } catch {
    return reply(502, 'Indexer unavailable', cors);
  }
  for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export default {
  fetch: (request, env) => handle(request, env, (input, init) => fetch(input, init)),
} satisfies ExportedHandler<Env>;
