import type { Bundle, CommitmentRef, Confirmed } from '@giveaway/protocol';
import type { prepareTransaction } from './cardano.ts';
import type { ServerDraftInfo } from './drafts.ts';
import type { Artifact, BundleLink } from './services.ts';

export type PreparedTransaction = Awaited<ReturnType<typeof prepareTransaction>>;

// Demo (recorded beacon, simulated chain) or preprod (wallet, project indexer). The `#network` select shows it; the
// flows read it here (plan step 12).
export type Mode = 'demo' | 'preprod';
// Where the draw being created stands. Every control and step marker of the draw panel is rendered from it
// (view.ts `renderFlow`), never set by the flows themselves (plan step 12):
//   setup      nothing previewed yet (or reset)
//   previewed  list and rules locked in the preview; commit next
//   committed  commitment created or submitted; confirmations next
//   confirmed  confirmed before the round; reveal next (and hosting on preprod)
//   revealed   winners revealed and verified
//   invalid    confirmation timing failed; this draw cannot be opened
export type Stage = 'setup' | 'previewed' | 'committed' | 'confirmed' | 'revealed' | 'invalid';

// One draw being created. A reset replaces the object, so a flow that awaited can tell its draw is gone.
export interface Draw {
  bundle?: Bundle;
  transaction?: PreparedTransaction;
  committed?: CommitmentRef;
  confirmed?: Confirmed;
  // The backend hosts this draw's bundle (plan step 10) until `expiresAt` (Unix seconds); `extensionsLeft` once the
  // backend has said (plan step 11).
  hosted?: { link: BundleLink; expiresAt: number; extensionsLeft?: number };
  // The announcement or proof last offered for sharing and download.
  shared?: Artifact;
}

// Everything the page remembers between events; one instance is created per page load.
export interface AppState {
  busy: boolean;
  mode: Mode;
  stage: Stage;
  draw: Draw;
  // What the share area of the draw panel shows: this draw's announcement or proof, or a verification link loaded in
  // the verification panel (bundle mode), whichever came last; nothing after a reset.
  sharing?: 'draw' | 'link';
  poll?: ReturnType<typeof setTimeout>;
  downloadUrl: string;
  bundleDownloadUrl: string;
  verifiedBundle?: Bundle;
  // The server draft id the local draft was last saved under (plan step 12), and the signer's server drafts as last
  // listed.
  serverDraftId?: string;
  serverDrafts?: ServerDraftInfo[];
}

export function createState(): AppState {
  return { busy: false, mode: 'demo', stage: 'setup', draw: {}, downloadUrl: '', bundleDownloadUrl: '' };
}
