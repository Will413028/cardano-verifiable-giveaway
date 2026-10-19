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
import { verifyProof } from '@giveaway/verifier';
import {
  announcement,
  type Artifact,
  type Chains,
  createChains,
  decodeInline,
  assembleProof,
  encodeInline,
  fetchHostedBundle,
  fetchTip,
  hostedShareLink,
  indexerFor,
  inlineShareLink,
  PROJECT_INDEXER,
  resolveArtifact,
} from './services.ts';
import { type AppState, createState } from './state.ts';
import {
  clearDrawProgress,
  el,
  input,
  isDemo,
  localTime,
  lockControls,
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
  show,
  status,
  text,
} from './view.ts';

// Entry point: owns the page state and wires DOM events to the draw and verification flows.

const now = () => Date.now() / 1000;

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
    unlock();
  }
}

function reset(state: AppState) {
  clearTimeout(state.poll);
  state.draw = {};
  clearDrawProgress();
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
}

function updateMode(state: AppState) {
  reset(state);
  renderMode(isDemo() ? FIXTURE.round : roundAt(now() + 1860));
}

// Outside run(): the tip is informational and must not lock the controls or replace the draw status.
async function refreshTip() {
  try {
    renderTip(await fetchTip());
  } catch (e) {
    renderTip(e as Error);
  }
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
  text('entrant-count', `${labels.length} participants`);
  status('Imported public labels. Other CSV columns were discarded.');
}

async function prepare(state: AppState) {
  reset(state);
  const round = Number(input('round').value);
  if (!isDemo() && roundTime(round) < now() + 1800) throw new Error('Choose a round at least 30 minutes in the future');
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
  text('preview-time', isDemo() ? 'Recorded quicknet round · simulated timing' : localTime(roundTime(round)));
  if (!isDemo()) {
    const { prepareTransaction } = await import('./cardano.ts');
    const transaction = await prepareTransaction(bundle, input('wallet').value, PROJECT_INDEXER);
    state.draw.transaction = transaction;
    status(
      `Ready to sign. Estimated fee: ${transaction.fee.toFixed(6)} test ADA. The transaction returns the transferred ADA to your wallet.`,
    );
  } else status('List and rules locked in the preview. Commit the demo draw next.');
  show(['commit-preview', 'commit'], true);
  text('commit', isDemo() ? 'Commit demo draw' : 'Sign and submit to preprod');
  el('stage-prepare').classList.add('done');
}

async function commit(state: AppState, chains: Chains) {
  const { bundle, transaction } = state.draw;
  if (!bundle) throw new Error('Preview a draw first');
  if (isDemo()) state.draw.committed = await chains.demo.commit(bundle);
  else {
    if (!transaction) throw new Error('Build a transaction first');
    state.draw.committed = { txHash: await transaction.signAndSubmit(), owner: transaction.owner };
  }
  const committed = state.draw.committed;
  el('commit').hidden = true;
  el('confirm').hidden = false;
  el('late').hidden = !isDemo();
  text('confirm', isDemo() ? 'Simulate 15 confirmations' : 'Check confirmations');
  status(
    isDemo()
      ? 'Demo commitment created. Simulate confirmations to continue.'
      : `Submitted ${committed.txHash}. Publish the commitment link before the round. Waiting for ${CONFIRMATIONS} confirmations.`,
  );
  // A pre-round link is available immediately. It identifies the committed bundle and reference.
  share(state, announcement(isDemo() ? 'demo' : 'preprod', bundle, committed));
  if (!isDemo()) scheduleConfirmation(state, chains);
}

function scheduleConfirmation(state: AppState, chains: Chains) {
  clearTimeout(state.poll);
  state.poll = setTimeout(async () => {
    const draw = state.draw;
    const { bundle, transaction } = draw;
    if (!bundle || !draw.committed || isDemo()) return;
    try {
      await confirm(state, chains);
    } catch (e) {
      // A reset or new preview while the indexer answered: the response belongs to a draw that is gone.
      if (state.draw !== draw) return;
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
  const confirmed = isDemo()
    ? chains.demo.confirm(committed, late)
    : await chains.indexer.readCommitment(committed.txHash, committed.owner);
  // Discard a response that arrives after the draw was reset or replaced.
  if (state.draw !== draw) return;
  draw.confirmed = confirmed;
  if (!checkTiming(confirmed, bundle.drand.round)) {
    show(['open', 'confirm', 'late'], false);
    clearTimeout(state.poll);
    if (!checkValidityBound(confirmed, bundle.drand.round))
      throw new Error(
        'The commitment has no validity upper bound (invalid_hereafter) before the round. This draw is invalid; choose a later round and commit again.',
      );
    throw new Error('Confirmation arrived too late. This draw is invalid; create a new drawId.');
  }
  clearTimeout(state.poll);
  el('stage-commit').classList.add('done');
  show(['confirm', 'late'], false);
  el('open').hidden = false;
  status(
    isDemo()
      ? 'Demo confirms before the recorded round. You can reveal the winners.'
      : `Fifteen confirmations verified. Round starts at ${localTime(roundTime(bundle.drand.round))}.`,
  );
}

async function reveal(state: AppState, chains: Chains) {
  const draw = state.draw;
  const { bundle, committed, confirmed } = draw;
  if (!bundle || !committed || !confirmed || !checkTiming(confirmed, bundle.drand.round))
    throw new Error('Need valid confirmation timing');
  if (!isDemo() && now() < roundTime(bundle.drand.round))
    throw new Error(`Round is not available yet. Starts at ${localTime(roundTime(bundle.drand.round))}.`);
  const beacon = isDemo() ? FIXTURE : await fetchBeacon(bundle.drand.round);
  if (state.draw !== draw) return;
  const proof = await assembleProof(isDemo() ? 'demo' : 'preprod', bundle, committed, beacon);
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
  show(['result', 'winner-result'], true);
  el('open').hidden = true;
  el('stage-result').classList.add('done');
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

function share(state: AppState, artifact: Artifact) {
  const link = inlineShareLink(location.href, encodeInline(artifact));
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' }));
  renderShare(artifact, link, state.downloadUrl);
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

async function load(state: AppState, chains: Chains, read: () => Promise<unknown>) {
  renderVerificationPending();
  state.verifiedBundle = undefined;
  try {
    const loaded = await resolveArtifact(await read(), now());
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

async function readHosted(url: string, expectedHash?: string) {
  const hosted = await fetchHostedBundle(url, expectedHash);
  renderHostedShare(hostedShareLink(location.href, hosted.url, hosted.hash));
  return JSON.parse(hosted.body);
}

function start() {
  const state = createState();
  const chains = createChains();
  input('network').onchange = () => {
    updateMode(state);
    if (!isDemo()) {
      void refreshTip();
      void run(state, refreshWallets);
    }
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
  input('lookup').oninput = () => renderLookup(state.verifiedBundle);
  input('proof-file').onchange = () => void load(state, chains, readProofFile);
  el('load-url').onclick = () => void load(state, chains, () => readHosted(input('bundle-url').value));
  text('boundary', BOUNDARY);
  updateMode(state);
  window.addEventListener('beforeunload', () => {
    clearTimeout(state.poll);
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  });
  const query = new URLSearchParams(location.search);
  if (location.hash.startsWith('#proof=')) void load(state, chains, async () => decodeInline(location.hash.slice(7)));
  else if (query.has('bundle'))
    void load(state, chains, () => readHosted(query.get('bundle') ?? '', query.get('hash') ?? undefined));
}

start();
