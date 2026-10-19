import { fetchBeacon } from '@giveaway/beacon';
import { BlockfrostChain, DemoChain } from '@giveaway/chain';
import {
  ARTIFACT_BYTE_LIMIT,
  type Beacon,
  type Bundle,
  type CommitmentRef,
  type Network,
  type Pending,
  type Proof,
  roundTime,
  selectWinners,
  sha256,
  validatePending,
  validateProof,
} from '@giveaway/protocol';

// DOM-free work behind the page: share encoding, hosted bundles, the backend proxy and assembling proofs.

// Replaced at build time by tools/build.mjs from GIVEAWAY_API_URL (default http://127.0.0.1:8787).
declare const GIVEAWAY_API_URL: string;
// Replaced at build time by tools/build.mjs from GIVEAWAY_INDEXER_URL: the project's Blockfrost-compatible indexer
// (default the local Dolos dev chain, http://127.0.0.1:3010).
declare const GIVEAWAY_INDEXER_URL: string;
export const PROJECT_INDEXER = GIVEAWAY_INDEXER_URL;

export interface Tip {
  blockHeight: number;
  epoch: number;
  slot: number;
  blockTime: number;
}

// The preprod chain tip read through the convenience backend's proxy (BR-01), which forwards the indexer's
// /blocks/latest. Display only: no verification step reads it, so the verifier still works when the backend is
// down (B1).
export async function fetchTip(): Promise<Tip> {
  const response = await fetch(`${GIVEAWAY_API_URL}/tip`, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Proxy /tip: HTTP ${response.status}`);
  const block: unknown = await response.json();
  const row = (block && typeof block === 'object' ? block : undefined) as Record<string, unknown> | undefined;
  const tip = { blockHeight: row?.height, epoch: row?.epoch, slot: row?.slot, blockTime: row?.time };
  if (!Object.values(tip).every(Number.isSafeInteger)) throw new Error('Proxy /tip: unexpected response');
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

export async function fetchHostedBundle(
  url: string,
  expectedHash?: string,
): Promise<{ url: URL; body: string; hash: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new Error('Use a public HTTPS URL without credentials');
  const response = await fetch(parsed, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Bundle host: HTTP ${response.status}`);
  const body = await response.text();
  if (new TextEncoder().encode(body).length > ARTIFACT_BYTE_LIMIT)
    throw new Error(`Bundle exceeds ${ARTIFACT_BYTE_LIMIT} bytes`);
  const hash = await sha256(body);
  if (expectedHash && hash !== expectedHash) throw new Error('Hosted bundle hash does not match the verification link');
  return { url: parsed, body, hash };
}

export function hostedShareLink(pageHref: string, bundleUrl: URL, hash: string): string {
  const share = new URL(pageHref);
  share.hash = '';
  share.search = new URLSearchParams({ bundle: bundleUrl.toString(), hash }).toString();
  return share.toString();
}

export function announcement(network: Network, bundle: Bundle, ref: CommitmentRef): Pending {
  return { format: 'giveaway-pending-2', network, bundle, txHash: ref.txHash, owner: ref.owner };
}

export async function assembleProof(
  network: Network,
  bundle: Bundle,
  ref: CommitmentRef,
  beacon: Beacon,
): Promise<Proof> {
  return {
    format: 'giveaway-proof-2',
    network,
    bundle,
    txHash: ref.txHash,
    owner: ref.owner,
    beacon,
    winners: await selectWinners(bundle, beacon.randomness),
  };
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
