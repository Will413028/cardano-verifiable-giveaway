import { FIXTURE, fetchBeacon } from '@giveaway/beacon';
import {
  ALGORITHM,
  ARTIFACT_BYTE_LIMIT,
  BOUNDARY,
  CONFIRMATIONS,
  checkTiming,
  checkValidityBound,
  computeCommitment,
  normalizeLabel,
  parseEntrants,
  QUICKNET,
  roundAt,
  roundTime,
  VERSION,
  validateBundle,
  validateProof,
} from '@giveaway/protocol';
import { NotIndexedError } from '@giveaway/chain';
import { assembleProof, verifyProof } from '@giveaway/verifier';
import {
  announcement,
  type Artifact,
  type BundleLink,
  bundleBytes,
  bundleShareLink,
  type Chains,
  createChains,
  decodeInline,
  deleteHosted,
  encodeInline,
  extendHosted,
  fetchBundle,
  fetchTip,
  hostBundle,
  indexerFor,
  inlineShareLink,
  type Loaded,
  type OwnerSigner,
  PROJECT_INDEXER,
  readShareLink,
  resolveArtifact,
  resolveBundle,
} from './services.ts';
import { type AppState, createState, type Mode } from './state.ts';
import {
  el,
  input,
  hostedReach,
  localTime,
  lockControls,
  renderFlow,
  renderHostedShare,
  renderLookup,
  renderMode,
  renderShare,
  renderEvidenceSource,
  renderTip,
  renderVerdict,
  renderVerificationNote,
  renderVerificationPending,
  renderWallets,
  renderWinners,
  status,
  text,
} from './view.ts';
import { wireDrafts } from './draft-flow.ts';

// Entry point: owns the page state and wires DOM events to the draw and verification flows. The flows change the
// state; the draw panel's controls are rendered from it (view.ts `renderFlow`) after every action (plan step 12).

const now = () => Date.now() / 1000;
const isDemo = (state: AppState) => state.mode === 'demo';

async function run(state: AppState, action: () => Promise<void>) {
  if (state.busy) return;
  state.busy = true;
  const unlock = lockControls();
  try {
    await action();
  } catch (e) {
    status((e as Error).message, true);
  } finally {
    state.busy = false;
    unlock(state.mode);
    renderFlow(state);
  }
}

function reset(state: AppState) {
  clearTimeout(state.poll);
  state.draw = {};
  state.stage = 'setup';
  state.sharing = undefined;
  revokeDownloads(state);
}

function revokeDownloads(state: AppState) {
  for (const url of [state.downloadUrl, state.bundleDownloadUrl]) if (url) URL.revokeObjectURL(url);
}

// A new mode starts a new draw. `round` is a restored draft's; otherwise demo uses the recorded round and preprod one
// about 31 minutes ahead.
function updateMode(state: AppState, mode: Mode, round?: number) {
  reset(state);
  state.mode = mode;
  renderMode(mode, mode === 'demo' ? FIXTURE.round : (round ?? roundAt(now() + 1860)));
  renderFlow(state);
}

// Outside run(): the tip is informational and must not lock the controls or replace the draw status.
async function refreshTip() {
  try {
    renderTip(await fetchTip());
  } catch (e) {
    renderTip(e as Error);
  }
}

// Preprod reads the chain tip and the browser's wallets. Inside a running action (a draft loaded or imported in preprod
// mode) run() would return at once, since the page is busy (review LOW 1), so the action lists the wallets itself and
// waits for them; otherwise listing them is an action of its own.
function enterPreprod(state: AppState): Promise<void> {
  void refreshTip();
  return state.busy ? refreshWallets() : run(state, refreshWallets);
}

async function refreshWallets() {
  const { wallets } = await import('./cardano.ts');
  renderWallets(wallets());
}

async function importCsv() {
  const file = input('csv').files?.[0];
  if (!file) return;
  if (file.size > 2_000_000) throw new Error('CSV exceeds 2 MB');
  const labels = parseEntrants(await file.text());
  input('entrants').value = labels.join('\n');
  // An edit like typing: the count follows and the draft is kept (draft-flow.ts).
  input('entrants').dispatchEvent(new Event('input'));
  status('Imported public labels. Other CSV columns were discarded.');
}

async function prepare(state: AppState) {
  reset(state);
  const round = Number(input('round').value);
  if (!isDemo(state) && roundTime(round) < now() + 1800)
    throw new Error('Choose a round at least 30 minutes in the future');
  const bundle = validateBundle({
    version: VERSION,
    algorithm: ALGORITHM,
    drawId: crypto.randomUUID(),
    entrants: parseEntrants(input('entrants').value).map(normalizeLabel),
    rules: { winners: Number(input('winner-count').value) },
    drand: { chainHash: QUICKNET, round },
  });
  state.draw.bundle = bundle;
  text('preview-count', String(bundle.entrants.length));
  text('preview-winners', String(bundle.rules.winners));
  text('preview-hash', await computeCommitment(bundle));
  text('preview-time', isDemo(state) ? 'Recorded quicknet round · simulated timing' : localTime(roundTime(round)));
  if (!isDemo(state)) {
    const { prepareTransaction } = await import('./cardano.ts');
    const transaction = await prepareTransaction(bundle, input('wallet').value, PROJECT_INDEXER);
    state.draw.transaction = transaction;
    status(
      `Ready to sign. Estimated fee: ${transaction.fee.toFixed(6)} test ADA. The transaction returns the transferred ADA to your wallet${
        transaction.withdrawn > 0
          ? ` and withdraws your ${transaction.withdrawn.toFixed(6)} test ADA of staking rewards into it`
          : ''
      }.`,
    );
  } else status('List and rules locked in the preview. Commit the demo draw next.');
  state.stage = 'previewed';
}

async function commit(state: AppState, chains: Chains) {
  const { bundle, transaction } = state.draw;
  if (!bundle) throw new Error('Preview a draw first');
  if (isDemo(state)) state.draw.committed = await chains.demo.commit(bundle);
  else {
    if (!transaction) throw new Error('Build a transaction first');
    state.draw.committed = { txHash: await transaction.signAndSubmit(), owner: transaction.owner };
  }
  const committed = state.draw.committed;
  state.stage = 'committed';
  status(
    isDemo(state)
      ? 'Demo commitment created. Simulate confirmations to continue.'
      : `Submitted ${committed.txHash}. Publish the commitment link before the round. Waiting for ${CONFIRMATIONS} confirmations.`,
  );
  // A pre-round link is available immediately. It identifies the committed bundle and reference.
  share(state, announcement(isDemo(state) ? 'demo' : 'preprod', bundle, committed));
  if (!isDemo(state)) scheduleConfirmation(state, chains);
}

function scheduleConfirmation(state: AppState, chains: Chains) {
  clearTimeout(state.poll);
  state.poll = setTimeout(async () => {
    const draw = state.draw;
    const { bundle, transaction } = draw;
    if (!bundle || !draw.committed || isDemo(state)) return;
    try {
      await confirm(state, chains);
      renderFlow(state);
    } catch (e) {
      // A reset or new preview while the indexer answered: the response belongs to a draw that is gone.
      if (state.draw !== draw) return;
      // A timing failure set the stage to invalid before throwing: its controls follow.
      renderFlow(state);
      status(`${(e as Error).message}. Next check in 30 seconds.`);
      // Past invalid_hereafter the ledger refuses the transaction: if it is not on chain by now it never will be.
      // Only an indexer with no record of it says so; a listed transaction without CBOR yet (CborPendingError)
      // may be on chain, so it keeps polling, since a resubmission would overlap the original's interval.
      if (e instanceof NotIndexedError && transaction && now() >= transaction.validUntil)
        status(
          'The commitment transaction expired before it was included (its invalid_hereafter has passed). Choose a later round and commit again.',
          true,
        );
      else if (now() < roundTime(bundle.drand.round)) scheduleConfirmation(state, chains);
      else status('Round has arrived without verified confirmations. This draw is invalid; create a new drawId.', true);
    }
  }, 30000);
}

async function confirm(state: AppState, chains: Chains, late = false) {
  const draw = state.draw;
  const { bundle, committed } = draw;
  if (!bundle || !committed) throw new Error('Commit a draw first');
  const confirmed = isDemo(state)
    ? chains.demo.confirm(committed, late)
    : await chains.indexer.readCommitment(committed.txHash, committed.owner);
  // Discard a response that arrives after the draw was reset or replaced.
  if (state.draw !== draw) return;
  draw.confirmed = confirmed;
  if (!checkTiming(confirmed, bundle.drand.round)) {
    state.stage = 'invalid';
    clearTimeout(state.poll);
    if (!checkValidityBound(confirmed, bundle.drand.round))
      throw new Error(
        'The commitment has no validity upper bound (invalid_hereafter) before the round. This draw is invalid; choose a later round and commit again.',
      );
    throw new Error('Confirmation arrived too late. This draw is invalid; create a new drawId.');
  }
  clearTimeout(state.poll);
  state.stage = 'confirmed';
  status(
    isDemo(state)
      ? 'Demo confirms before the recorded round. You can reveal the winners.'
      : `Fifteen confirmations verified. Round starts at ${localTime(roundTime(bundle.drand.round))}.`,
  );
}

async function reveal(state: AppState, chains: Chains) {
  const draw = state.draw;
  const { bundle, committed, confirmed } = draw;
  if (!bundle || !committed || !confirmed || !checkTiming(confirmed, bundle.drand.round))
    throw new Error('Need valid confirmation timing');
  if (!isDemo(state) && now() < roundTime(bundle.drand.round))
    throw new Error(`Round is not available yet. Starts at ${localTime(roundTime(bundle.drand.round))}.`);
  const beacon = isDemo(state) ? FIXTURE : await fetchBeacon(bundle.drand.round);
  if (state.draw !== draw) return;
  const proof = await assembleProof(isDemo(state) ? 'demo' : 'preprod', bundle, committed, beacon);
  const verdict = await verifyProof(proof, { chain: chains.indexer });
  if (state.draw !== draw) return;
  if (verdict.status === 'FAIL')
    throw new Error(
      verdict.checks
        .filter((c) => c.result !== 'pass')
        .map((c) => c.detail)
        .join('; '),
    );
  renderWinners(verdict.winners);
  state.stage = 'revealed';
  status(
    verdict.status === 'DEMO PASS'
      ? 'Demo complete. Chain evidence is simulated; drand signature and winners are independently checked.'
      : 'Draw opened. Independent verification passed.',
  );
  text(
    'result-note',
    verdict.status === 'DEMO PASS'
      ? 'DEMO · Recorded randomness, simulated commitment timing. Not an on-chain fairness claim.'
      : 'Publish the bundle so participants can independently verify it.',
  );
  share(state, proof);
  await renderVerification(state, chains, proof);
}

// Two downloads (plan step 10): the canonical bundle bytes, which the CLI's bundle mode and any host serve as they are,
// and the announcement or proof. Once the backend hosts the bundle past the round, its link (txHash + bundle hash)
// replaces the inline one. A hosting that ends before the round (a round more than 12 months after the first hosting,
// ADR Amendment 5) would leave that link dead when participants need it, so the page keeps offering the inline link (or
// none, with the guidance to publish the bundle file) and says why (hostedReach).
function share(state: AppState, artifact: Artifact) {
  state.draw.shared = artifact;
  state.sharing = 'draw';
  const hosted = state.draw.hosted;
  const link =
    hosted && hosted.expiresAt > roundTime(artifact.bundle.drand.round)
      ? bundleShareLink(location.href, hosted.link)
      : inlineShareLink(location.href, encodeInline(artifact));
  revokeDownloads(state);
  const json = (body: BlobPart) => URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  state.downloadUrl = json(JSON.stringify(artifact, null, 2));
  state.bundleDownloadUrl = json(bundleBytes(artifact.bundle));
  renderShare(artifact, link, { artifact: state.downloadUrl, bundle: state.bundleDownloadUrl }, hosted?.expiresAt);
}

// Owner operations on the hosted copy (plan step 11) are signed by the wallet with the organizer's stake key, the
// identity of the committing address (committed.owner), each operation on its own.
function ownerSigner(owner: string): OwnerSigner {
  return async (message) => {
    const { signOwnerOperation } = await import('./cardano.ts');
    return signOwnerOperation(input('wallet').value, owner, message);
  };
}

async function host(state: AppState) {
  const draw = state.draw;
  const { bundle, committed, confirmed, shared } = draw;
  if (isDemo(state) || !bundle || !committed || !confirmed || !shared)
    throw new Error('Host a bundle after its commitment is confirmed');
  const link = { txHash: committed.txHash, bundleHash: confirmed.bundleHash };
  const { expiresAt } = await hostBundle(link, bundle, ownerSigner(committed.owner));
  if (state.draw !== draw) return;
  draw.hosted = { link, expiresAt };
  share(state, shared);
  status(`Bundle hosted. ${hostedReach(expiresAt, bundle.drand.round)}`);
}

async function extendHosting(state: AppState) {
  const draw = state.draw;
  const { bundle, committed, hosted, shared } = draw;
  if (!bundle || !committed || !hosted || !shared) throw new Error('Host the bundle first');
  const { expiresAt, extensionsLeft } = await extendHosted(hosted.link, ownerSigner(committed.owner));
  if (state.draw !== draw) return;
  hosted.expiresAt = expiresAt;
  hosted.extensionsLeft = extensionsLeft;
  share(state, shared);
  status(
    `Hosting extended. ${hostedReach(expiresAt, bundle.drand.round)}${extensionsLeft === 0 ? ' This was the last extension: hosting ends 36 months after the earlier of the round and the first hosting.' : ''}`,
  );
}

// BR-13: after a deletion the hosted link is dead, so the share link goes back to the inline one (or none) and the
// organizer is reminded that the downloaded files are now the copy participants verify from.
async function deleteHostedBundle(state: AppState) {
  const draw = state.draw;
  const { committed, hosted, shared } = draw;
  if (!committed || !hosted || !shared) throw new Error('Nothing is hosted for this draw');
  await deleteHosted(hosted.link, ownerSigner(committed.owner));
  if (state.draw !== draw) return;
  draw.hosted = undefined;
  share(state, shared);
  status(
    'Hosted bundle deleted: the hosted verification link no longer works. Keep the downloaded bundle file and proof: participants can still verify from them (publish the bundle file at an HTTPS URL to share a link again).',
  );
}

async function copyShareLink() {
  const value = input('share-link').value;
  if (!value) throw new Error('Host the downloaded bundle publicly and load its HTTPS URL to create a share link');
  try {
    await navigator.clipboard.writeText(value);
    status('Verification link copied.');
  } catch {
    input('share-link').focus();
    input('share-link').select();
    status('Select and copy the verification link.');
  }
}

async function renderVerification(state: AppState, chains: Chains, value: unknown) {
  // Read when a bundle is loaded: an invalid URL fails this verification, not the page.
  const chain = indexerFor(chains, input('indexer').value);
  const verdict = await verifyProof(value, { chain });
  state.verifiedBundle = verdict.status === 'FAIL' ? undefined : validateProof(value).bundle;
  renderVerdict(verdict, state.verifiedBundle);
  // Only a well-formed artifact reached the evidence step; its network says which source that was.
  let network: string | undefined;
  try {
    network = validateProof(value).network;
  } catch {}
  renderEvidenceSource(
    network === 'preprod' ? { indexer: chain.base, own: chain !== chains.indexer } : network === 'demo' ? 'demo' : null,
  );
}

async function load(state: AppState, chains: Chains, read: () => Promise<Loaded>) {
  renderVerificationPending();
  state.verifiedBundle = undefined;
  try {
    const loaded = await read();
    if (loaded.kind === 'demo-commitment')
      renderVerificationNote('DEMO COMMITMENT — simulated evidence. Open the draw to share a complete result bundle.');
    else if (loaded.kind === 'awaiting-round')
      renderVerificationNote(
        `Commitment announced. Awaiting round ${loaded.round}. Chain evidence is checked when the complete result is loaded.`,
      );
    else await renderVerification(state, chains, loaded.value);
  } catch (e) {
    renderVerificationNote(`FAIL: ${(e as Error).message}`, true);
  }
}

async function readProofFile() {
  const file = input('proof-file').files?.[0];
  if (!file || file.size > ARTIFACT_BYTE_LIMIT)
    throw new Error(`Choose a JSON bundle no larger than ${ARTIFACT_BYTE_LIMIT} bytes`);
  return JSON.parse(await file.text());
}

// A verification link or the panel's transaction and URL fields (bundle mode): the bytes come from the named source or
// the backend's copy, must hash to the link's bundle hash, and the verifier recomputes everything else.
async function readBundle(
  state: AppState,
  chains: Chains,
  link: { txHash: string; bundleHash?: string; source?: string },
) {
  const { bundle, hash } = await fetchBundle(link);
  const pinned: BundleLink = { txHash: link.txHash, bundleHash: hash, ...(link.source ? { source: link.source } : {}) };
  state.sharing = 'link';
  renderHostedShare(bundleShareLink(location.href, pinned));
  renderFlow(state);
  return resolveBundle(bundle, link.txHash, { chain: indexerFor(chains, input('indexer').value), now: now() });
}

function bundleFields(): { txHash: string; source?: string } {
  const txHash = input('bundle-tx').value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(txHash)) throw new Error('Enter the commitment transaction hash (64 hex characters)');
  const source = input('bundle-url').value.trim();
  return { txHash, ...(source ? { source } : {}) };
}

// A loaded verification artifact (proof or announcement) as the verification panel resolves it.
const artifact = (read: () => Promise<unknown>) => async () => resolveArtifact(await read(), now());

function start() {
  const state = createState();
  const chains = createChains();
  input('network').onchange = () => {
    updateMode(state, input('network').value === 'preprod' ? 'preprod' : 'demo');
    if (!isDemo(state)) void enterPreprod(state);
  };
  el('refresh-wallets').onclick = () => void run(state, refreshWallets);
  input('entrants').oninput = () => {
    try {
      text('entrant-count', `${parseEntrants(input('entrants').value).length} participants`);
    } catch (e) {
      text('entrant-count', (e as Error).message);
    }
  };
  input('csv').onchange = () => void run(state, importCsv);
  el('draw-form').onsubmit = (event) => {
    event.preventDefault();
    void run(state, () => prepare(state));
  };
  el('commit').onclick = () => void run(state, () => commit(state, chains));
  el('confirm').onclick = () => void run(state, () => confirm(state, chains));
  el('late').onclick = () => void run(state, () => confirm(state, chains, true));
  el('open').onclick = () => void run(state, () => reveal(state, chains));
  el('share').onclick = () => void run(state, copyShareLink);
  el('host').onclick = () => void run(state, () => host(state));
  el('extend-hosting').onclick = () => void run(state, () => extendHosting(state));
  el('delete-hosted').onclick = () => void run(state, () => deleteHostedBundle(state));
  input('lookup').oninput = () => renderLookup(state.verifiedBundle);
  input('proof-file').onchange = () => void load(state, chains, artifact(readProofFile));
  el('load-url').onclick = () => void load(state, chains, async () => readBundle(state, chains, bundleFields()));
  text('boundary', BOUNDARY);
  updateMode(state, 'demo');
  window.addEventListener('beforeunload', () => {
    clearTimeout(state.poll);
    revokeDownloads(state);
  });
  // The draft kept in this browser, if any, replaces the defaults (plan step 12; BR-11); a link the page was opened
  // with is loaded after that.
  void wireDrafts(state, { run, setMode: updateMode, enterPreprod }).then(() => openLink(state, chains));
}

function openLink(state: AppState, chains: Chains) {
  if (location.hash.startsWith('#proof='))
    void load(
      state,
      chains,
      artifact(async () => decodeInline(location.hash.slice(7))),
    );
  // readShareLink throws for the former hosted-proof link (also `bundle=`); load() reports it.
  else if (['tx', 'bundle'].some((name) => new URLSearchParams(location.search).has(name)))
    void load(state, chains, async () => {
      const link = readShareLink(location.search);
      if (!link) throw new Error('This page link carries no verification link');
      return readBundle(state, chains, link);
    });
}

start();
