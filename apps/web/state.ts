import type { Bundle, CommitmentRef, Confirmed } from '@giveaway/protocol';
import type { prepareTransaction } from './cardano.ts';
import type { Artifact, BundleLink } from './services.ts';

export type PreparedTransaction = Awaited<ReturnType<typeof prepareTransaction>>;

// One draw being created. A reset replaces the object, so a flow that awaited can tell its draw is gone.
export interface Draw {
  bundle?: Bundle;
  transaction?: PreparedTransaction;
  committed?: CommitmentRef;
  confirmed?: Confirmed;
  // The backend hosts this draw's bundle (plan step 10) until `expiresAt` (Unix seconds).
  hosted?: { link: BundleLink; expiresAt: number };
  // The announcement or proof last offered for sharing and download.
  shared?: Artifact;
}

// Everything the page remembers between events; one instance is created per page load.
export interface AppState {
  busy: boolean;
  draw: Draw;
  poll?: ReturnType<typeof setTimeout>;
  downloadUrl: string;
  bundleDownloadUrl: string;
  verifiedBundle?: Bundle;
}

export function createState(): AppState {
  return { busy: false, draw: {}, downloadUrl: '', bundleDownloadUrl: '' };
}
