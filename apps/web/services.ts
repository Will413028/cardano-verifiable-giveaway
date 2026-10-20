import { fetchBeacon } from '@giveaway/beacon';
import { BlockfrostChain, DemoChain } from '@giveaway/chain';
import {
  BUNDLE_BYTE_LIMIT,
  type Bundle,
  type CommitmentRef,
  canonicalize,
  type Network,
  type Pending,
  type OwnerOperationName,
  ownerOperationText,
  type Proof,
  roundTime,
  sha256,
  validateBundle,
  validatePending,
  validateProof,
} from '@giveaway/protocol';
import { assembleProof, type BundleOptions, bundleProof, RoundNotReachedError } from '@giveaway/verifier';

// DOM-free work behind the page: share encoding, hosted bundles, the chain tip and resolving artifacts into proofs.

// Replaced at build time by tools/build.mjs from GIVEAWAY_INDEXER_URL: the project's Blockfrost-compatible indexer
// (default the local Dolos dev chain, http://127.0.0.1:3010).
declare const GIVEAWAY_INDEXER_URL: string;
export const PROJECT_INDEXER = GIVEAWAY_INDEXER_URL;
// Replaced at build time from GIVEAWAY_API_URL: the convenience backend that hosts bundles (default the local
// `make api`, http://127.0.0.1:8787). Verification never needs it: a bundle can come from any URL (B1).
declare const GIVEAWAY_API_URL: string;
export const API_URL = GIVEAWAY_API_URL;

export interface Tip {
  blockHeight: number;
  epoch: number;
  slot: number;
  blockTime: number;
}

// The preprod chain tip, read directly from the project indexer's /blocks/latest (PD8 A: no backend proxy; BR-01).
// Display only: no verification step reads it.
export async function fetchTip(): Promise<Tip> {
  const response = await fetch(`${PROJECT_INDEXER}/blocks/latest`, {
    credentials: 'omit',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Indexer /blocks/latest: HTTP ${response.status}`);
  const block: unknown = await response.json();
  const row = (block && typeof block === 'object' ? block : undefined) as Record<string, unknown> | undefined;
  const tip = { blockHeight: row?.height, epoch: row?.epoch, slot: row?.slot, blockTime: row?.time };
  if (!Object.values(tip).every(Number.isSafeInteger)) throw new Error('Indexer /blocks/latest: unexpected response');
  return tip as Tip;
}

// Chain readers are created once per page load and passed to every flow that reads evidence. `indexer` reads the
// project's indexer; the verification page may replace it with one the visitor names (`indexerFor`).
export interface Chains {
  demo: DemoChain;
  indexer: BlockfrostChain;
}
export const createChains = (): Chains => ({ demo: new DemoChain(), indexer: new BlockfrostChain(PROJECT_INDEXER) });
// The indexer the verification page reads: the visitor's own Blockfrost-compatible node when one is given (BR-16),
// otherwise the project's.
export function indexerFor(chains: Chains, value: string): BlockfrostChain {
  return value.trim() ? new BlockfrostChain(value.trim()) : chains.indexer;
}

export type Artifact = Proof | Pending;

const INLINE_LINK_LIMIT = 12000;
const INLINE_READ_LIMIT = 16000;

export function encodeInline(artifact: Artifact): string {
  const bytes = new TextEncoder().encode(JSON.stringify(artifact));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// Empty when the artifact is too large to travel inside the link.
export function inlineShareLink(pageHref: string, encoded: string): string {
  const link = new URL(pageHref);
  link.hash = `proof=${encoded}`;
  link.search = '';
  return encoded.length <= INLINE_LINK_LIMIT ? link.toString() : '';
}

export function decodeInline(encoded: string): unknown {
  if (encoded.length > INLINE_READ_LIMIT) throw new Error('Inline bundle too large');
  const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
}

// The canonical bundle bytes: what the commitment's bundleHash is the SHA-256 of, the `<drawId>.bundle.json` download,
// what the backend hosts and what the CLI's bundle mode reads.
export const bundleBytes = (bundle: Bundle) => new TextEncoder().encode(canonicalize(validateBundle(bundle)));

const TX_HASH = /^[a-f0-9]{64}$/;
// A verification link (BR-10, F9): the commitment transaction and the bundle hash, plus `source` when the bundle bytes
// are hosted somewhere other than the project backend. Beacon and winners are recomputed by the verifier.
export interface BundleLink {
  txHash: string;
  bundleHash: string;
  source?: string;
}
export function bundleShareLink(pageHref: string, link: BundleLink): string {
  const share = new URL(pageHref);
  share.hash = '';
  share.search = new URLSearchParams({
    tx: link.txHash,
    bundle: link.bundleHash,
    ...(link.source ? { source: link.source } : {}),
  }).toString();
  return share.toString();
}
// The link in a page URL's query, or null when it carries none. The former hosted-proof link (`bundle` = a proof file
// URL, `hash` = that file's SHA-256, no `tx`) is refused with an explicit error: the proof's hash is on no chain (F9). A
// link in the current format with a missing or malformed field gets its own message, not the former-format one.
export function readShareLink(search: string): BundleLink | null {
  const query = new URLSearchParams(search);
  if (!query.has('tx') && !query.has('bundle')) return null;
  const txHash = query.get('tx') ?? '';
  const bundleHash = query.get('bundle') ?? '';
  if (query.has('hash') && !query.has('tx'))
    throw new Error(
      'This link uses the former hosted-proof format, which is no longer supported. A verification link names the commitment transaction (tx) and the bundle hash (bundle); ask the organizer for one, or load the downloaded files.',
    );
  const ask = 'Check that the whole link was copied, or ask the organizer for it again.';
  if (!query.has('tx')) throw new Error(`This verification link has no commitment transaction (tx). ${ask}`);
  if (!TX_HASH.test(txHash))
    throw new Error(`The commitment transaction (tx) in this link is not a 64-character hex hash. ${ask}`);
  if (!TX_HASH.test(bundleHash))
    throw new Error(`The bundle hash (bundle) in this link is missing or not a 64-character hex hash. ${ask}`);
  const source = query.get('source') ?? undefined;
  return { txHash, bundleHash, ...(source ? { source } : {}) };
}

// The bundle bytes of a link, from `source` or else from the backend's copy for the commitment (GET /bundles/{txHash}),
// checked against the expected hash whoever served them.
export async function fetchBundle(
  link: { txHash: string; bundleHash?: string; source?: string },
  api = API_URL,
): Promise<{ bundle: Bundle; hash: string }> {
  let url: URL;
  if (link.source) {
    url = new URL(link.source);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Use a public HTTPS URL without credentials');
  } else url = new URL(`${api}/bundles/${link.txHash}`);
  const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!response.ok)
    throw new Error(
      link.source
        ? `Bundle host: HTTP ${response.status}`
        : `Hosted bundle: HTTP ${response.status} (${(await response.text()).slice(0, 200)})`,
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > BUNDLE_BYTE_LIMIT) throw new Error(`Bundle exceeds ${BUNDLE_BYTE_LIMIT} bytes`);
  const hash = await sha256(bytes);
  if (link.bundleHash && hash !== link.bundleHash)
    throw new Error('Hosted bundle hash does not match the verification link');
  return { bundle: validateBundle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))), hash };
}

// Owner operations (plan step 11; BR-09): each one is signed on its own (PD4: no session). The text to sign names this
// page's host, the operation, preprod, the commitment and its bundle hash, and a nonce with the backend's clock
// (GET /nonce); `sign` asks the wallet (cardano.ts `signOwnerOperation`) and answers the CIP-30 DataSignature.
export type OwnerSigner = (text: string) => Promise<{ signature: string; key: string }>;
async function ownerAuthorization(
  operation: OwnerOperationName,
  ref: { txHash: string; bundleHash: string },
  sign: OwnerSigner,
  api: string,
): Promise<string> {
  const response = await fetch(`${api}/nonce`, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Backend nonce: HTTP ${response.status}`);
  const { nonce, issuedAt } = await response.json();
  if (typeof nonce !== 'string' || !Number.isSafeInteger(issuedAt))
    throw new Error('Backend nonce: unexpected response');
  const text = ownerOperationText({ domain: location.host, operation, network: 'preprod', ...ref, nonce, issuedAt });
  const { signature, key } = await sign(text);
  // CIP-30 answers hex; the backend reads it in lowercase.
  return `CIP30 ${signature.toLowerCase()} ${key.toLowerCase()}`;
}
async function ownerRequest(
  operation: OwnerOperationName,
  ref: { txHash: string; bundleHash: string },
  sign: OwnerSigner,
  init: { method: string; path: string; body?: BodyInit },
  api: string,
): Promise<Record<string, unknown>> {
  const authorization = await ownerAuthorization(operation, ref, sign, api);
  const response = await fetch(`${api}${init.path}`, {
    method: init.method,
    body: init.body,
    headers: { 'Content-Type': 'application/json', Authorization: authorization },
    credentials: 'omit',
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`The backend refused to ${operation}: HTTP ${response.status} (${text.slice(0, 300)})`);
  return JSON.parse(text);
}

// Asks the backend to host the canonical bundle bytes of a confirmed commitment (BR-06), signed by the organizer. The
// backend checks them against the chain itself; this only reports what it answered.
export async function hostBundle(
  ref: { txHash: string; bundleHash: string },
  bundle: Bundle,
  sign: OwnerSigner,
  api = API_URL,
): Promise<{ expiresAt: number }> {
  const answer = await ownerRequest(
    'host',
    ref,
    sign,
    { method: 'PUT', path: `/bundles/${ref.txHash}`, body: bundleBytes(bundle) },
    api,
  );
  if (!Number.isSafeInteger(answer.expiresAt)) throw new Error('Bundle hosting: unexpected response');
  return { expiresAt: answer.expiresAt as number };
}
// The organizer deletes the hosted copy (BR-13): the hosted link stops working; downloaded files still verify.
export async function deleteHosted(
  ref: { txHash: string; bundleHash: string },
  sign: OwnerSigner,
  api = API_URL,
): Promise<void> {
  await ownerRequest('delete', ref, sign, { method: 'DELETE', path: `/bundles/${ref.txHash}` }, api);
}
// The organizer extends the hosting by 12 months, up to 36 months after its base time (BR-17).
export async function extendHosted(
  ref: { txHash: string; bundleHash: string },
  sign: OwnerSigner,
  api = API_URL,
): Promise<{ expiresAt: number; extensionsLeft: number }> {
  const answer = await ownerRequest(
    'extend',
    ref,
    sign,
    { method: 'POST', path: `/bundles/${ref.txHash}/extend` },
    api,
  );
  if (!Number.isSafeInteger(answer.expiresAt) || !Number.isSafeInteger(answer.extensionsLeft))
    throw new Error('Hosting extension: unexpected response');
  return { expiresAt: answer.expiresAt as number, extensionsLeft: answer.extensionsLeft as number };
}

export function announcement(network: Network, bundle: Bundle, ref: CommitmentRef): Pending {
  return { format: 'giveaway-pending-2', network, bundle, txHash: ref.txHash, owner: ref.owner };
}

export type Loaded =
  | { kind: 'demo-commitment' }
  | { kind: 'awaiting-round'; round: number }
  | { kind: 'proof'; value: unknown };

// A pending announcement becomes a checkable proof once its round has arrived on preprod; the verifier
// then reads the referenced commitment from the chain.
export async function resolveArtifact(value: unknown, now: number): Promise<Loaded> {
  if ((value as { format?: unknown } | null)?.format !== 'giveaway-pending-2') {
    validateProof(value);
    return { kind: 'proof', value };
  }
  const pending = validatePending(value);
  const { bundle } = pending;
  if (pending.network !== 'preprod') return { kind: 'demo-commitment' };
  if (now < roundTime(bundle.drand.round)) return { kind: 'awaiting-round', round: bundle.drand.round };
  const beacon = await fetchBeacon(bundle.drand.round);
  return { kind: 'proof', value: await assembleProof('preprod', bundle, pending, beacon) };
}

// A bundle and its commitment transaction (a verification link) become a proof once the round has arrived; before that
// the page only reports the wait. The owner is read from the transaction (bundle mode, @giveaway/verifier).
export async function resolveBundle(bundle: Bundle, txHash: string, options: BundleOptions): Promise<Loaded> {
  try {
    return { kind: 'proof', value: await bundleProof(bundle, txHash, options) };
  } catch (e) {
    if (e instanceof RoundNotReachedError) return { kind: 'awaiting-round', round: e.round };
    throw e;
  }
}
