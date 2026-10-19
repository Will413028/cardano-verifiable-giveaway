// Convenience backend entry (ADR 2026-10-18-typescript-convenience-backend). It forwards nothing to the indexer: since
// PD8 A the page reads the project Dolos directly, through the reverse proxy in deploy/dolos-proxy/ (BR-01). Bundle
// hosting (plan step 10), owner operations (11) and drafts (12) add their routes here. It never signs, submits,
// generates randomness or decides PASS/FAIL (B2), and verification never depends on it (B1).
//
// BR-05: no request content is logged. Nothing here reads a body or writes to the console, and wrangler.jsonc keeps
// Workers observability (invocation logs, which record request URLs) disabled.

export interface Env {
  // The one browser origin allowed to call the backend (BR-04): the page's own.
  ALLOWED_ORIGIN?: string;
}

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

export function handle(request: Request, env: Env): Response {
  const allowed = allowedOrigin(env);
  const origin = request.headers.get('Origin');
  // BR-04: a browser on any other origin is refused before routing; requests without an Origin header are not from a
  // cross-origin page and get no CORS header.
  if (origin !== null && origin !== allowed) return reply(403, 'Origin not allowed', { Vary: 'Origin' });
  const cors: Record<string, string> = origin === null ? {} : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
  return reply(404, 'Not found', cors);
}

export default {
  fetch: (request, env) => handle(request, env),
} satisfies ExportedHandler<Env>;
