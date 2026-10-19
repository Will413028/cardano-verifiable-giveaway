import { indexerUrl } from '@giveaway/chain';

// Read-only indexer paths the proxy forwards (BR-01), keyed by the path the page asks for: `/tip` is the
// Blockfrost-shaped `/blocks/latest`. Whether the proxy stays at all is PD8 (step 9); anything else is refused.
export const ENDPOINTS: ReadonlyMap<string, string> = new Map([['tip', 'blocks/latest']]);

export type Upstream = (input: string, init: RequestInit) => Promise<Response>;

// B2: the upstream status and body bytes pass through untouched. The proxy never parses or rewrites them.
// `indexer` is the project's Blockfrost-compatible indexer (wrangler.jsonc INDEXER_URL); a missing or invalid one
// throws, which the caller answers as an unavailable indexer.
export async function forward(endpoint: string, upstream: Upstream, indexer: string): Promise<Response> {
  const path = ENDPOINTS.get(endpoint);
  if (!path) throw new Error(`Endpoint not allowed: ${endpoint}`);
  const response = await upstream(`${indexerUrl(indexer)}/${path}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  return new Response(response.body, {
    status: response.status,
    headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json' },
  });
}
