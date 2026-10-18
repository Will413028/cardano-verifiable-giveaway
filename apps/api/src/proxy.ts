import { DEFAULT_INDEXER } from '@giveaway/chain';

// Read-only Koios endpoints the proxy forwards (BR-01). Step 9 extends the list; anything else is refused.
export const ENDPOINTS: ReadonlySet<string> = new Set(['tip']);

export type Upstream = (input: string, init: RequestInit) => Promise<Response>;

// B2: the upstream status and body bytes pass through untouched. The proxy never parses or rewrites them.
export async function forward(endpoint: string, upstream: Upstream): Promise<Response> {
  if (!ENDPOINTS.has(endpoint)) throw new Error(`Endpoint not allowed: ${endpoint}`);
  const response = await upstream(`${DEFAULT_INDEXER}/${endpoint}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  return new Response(response.body, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
  });
}
