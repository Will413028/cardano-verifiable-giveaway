import { fetchBeacon } from '@giveaway/beacon';
import { DemoChain, KoiosChain } from '@giveaway/chain';
import {
  type Beacon,
  type Bundle,
  type Commitment,
  type Proof,
  roundTime,
  selectWinners,
  sha256,
  validateBundle,
  validateProof,
} from '@giveaway/protocol';

// DOM-free work behind the page: share encoding, hosted bundles and assembling proofs.

// Chain readers are created once per page load and passed to every flow that reads evidence.
export interface Chains {
  demo: DemoChain;
  koios: KoiosChain;
}
export const createChains = (): Chains => ({ demo: new DemoChain(), koios: new KoiosChain() });

export interface Pending {
  format: 'giveaway-pending-1';
  network: string;
  bundle: Bundle;
  commitment: Commitment;
}
export type Artifact = Proof | Pending;

const INLINE_LINK_LIMIT = 12000;
const INLINE_READ_LIMIT = 16000;
const BUNDLE_LIMIT = 8_000_000;

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
  if (new TextEncoder().encode(body).length > BUNDLE_LIMIT) throw new Error('Bundle exceeds 8 MB');
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

export async function assembleProof(
  network: Proof['network'],
  bundle: Bundle,
  commitment: Commitment,
  beacon: Beacon,
): Promise<Proof> {
  return {
    format: 'giveaway-proof-1',
    network,
    bundle,
    commitment,
    beacon,
    winners: await selectWinners(bundle, beacon.randomness),
  };
}

export type Loaded =
  | { kind: 'demo-commitment' }
  | { kind: 'awaiting-round'; round: number }
  | { kind: 'proof'; value: unknown };

// A pending announcement becomes a checkable proof once its round has arrived on preprod.
export async function resolveArtifact(value: unknown, now: number, koios: KoiosChain): Promise<Loaded> {
  if ((value as { format?: unknown } | null)?.format !== 'giveaway-pending-1') {
    validateProof(value);
    return { kind: 'proof', value };
  }
  const pending = value as Pending;
  const bundle = validateBundle(pending.bundle);
  if (pending.network !== 'preprod') return { kind: 'demo-commitment' };
  if (now < roundTime(bundle.drand.round)) return { kind: 'awaiting-round', round: bundle.drand.round };
  const commitment = await koios.readCommitment(pending.commitment.txHash, pending.commitment.owner);
  const beacon = await fetchBeacon(bundle.drand.round);
  return { kind: 'proof', value: await assembleProof('preprod', bundle, commitment, beacon) };
}
