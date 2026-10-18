import { FIXTURE, fetchBeacon } from '@giveaway/beacon';
import {
  ALGORITHM,
  BOUNDARY,
  CONFIRMATIONS,
  checkTiming,
  computeCommitment,
  normalizeLabel,
  parseEntrants,
  QUICKNET,
  roundAt,
  roundTime,
  type Bundle,
  type Commitment,
  VERSION,
  validateBundle,
  validateProof,
} from '@giveaway/protocol';
import { verifyProof } from '@giveaway/verifier';
import {
  type Artifact,
  type Chains,
  createChains,
  decodeInline,
  assembleProof,
  encodeInline,
  fetchHostedBundle,
  hostedShareLink,
  inlineShareLink,
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
    const transaction = await prepareTransaction(bundle, input('wallet').value);
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
  if (isDemo()) state.draw.commitment = await chains.demo.commit(bundle);
  else {
    if (!transaction) throw new Error('Build a transaction first');
    const txHash = await transaction.signAndSubmit();
    state.draw.commitment = {
      txHash,
      owner: transaction.owner,
      bundleHash: await computeCommitment(bundle),
      drawId: bundle.drawId,
      round: bundle.drand.round,
      blockHeight: 0,
      blockTime: 0,
      confirmedAt: 0,
    };
  }
  const commitment = state.draw.commitment;
  el('commit').hidden = true;
  el('confirm').hidden = false;
  el('late').hidden = !isDemo();
  text('confirm', isDemo() ? 'Simulate 15 confirmations' : 'Check confirmations');
  status(
    isDemo()
      ? 'Demo commitment created. Simulate confirmations to continue.'
      : `Submitted ${commitment.txHash}. Publish the commitment link before the round. Waiting for ${CONFIRMATIONS} confirmations.`,
  );
  // A pre-round link is available immediately. It identifies the committed bundle and reference.
  share(state, { format: 'giveaway-pending-1', network: isDemo() ? 'demo' : 'preprod', bundle, commitment });
  if (!isDemo()) scheduleConfirmation(state, chains);
}

function scheduleConfirmation(state: AppState, chains: Chains) {
  clearTimeout(state.poll);
  state.poll = setTimeout(async () => {
    if (!state.draw.bundle || !state.draw.commitment || isDemo()) return;
    try {
      await confirm(state, chains);
    } catch (e) {
      status(`${(e as Error).message}. Next check in 30 seconds.`);
      // Read after the await, as before the split: a reset during the check leaves no bundle.
      if (now() < roundTime((state.draw.bundle as Bundle).drand.round)) scheduleConfirmation(state, chains);
      else status('Round has arrived without verified confirmations. This draw is invalid; create a new drawId.', true);
    }
  }, 30000);
}

async function confirm(state: AppState, chains: Chains, late = false) {
  const { commitment } = state.draw;
  if (!state.draw.bundle || !commitment) throw new Error('Commit a draw first');
  const confirmed = isDemo()
    ? chains.demo.confirm(commitment, late)
    : await chains.koios.readCommitment(commitment.txHash, commitment.owner);
  state.draw.commitment = confirmed;
  // Read after the await, as before the split: a reset or new preview may have replaced the draw.
  const bundle = state.draw.bundle as Bundle;
  if (!checkTiming(confirmed, bundle.drand.round)) {
    show(['open', 'confirm', 'late'], false);
    clearTimeout(state.poll);
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
  const { bundle, commitment } = state.draw;
  if (!bundle || !commitment || !checkTiming(commitment, bundle.drand.round))
    throw new Error('Need valid confirmation timing');
  if (!isDemo() && now() < roundTime(bundle.drand.round))
    throw new Error(`Round is not available yet. Starts at ${localTime(roundTime(bundle.drand.round))}.`);
  const beacon = isDemo() ? FIXTURE : await fetchBeacon(bundle.drand.round);
  // Read after the beacon await, as before the split: a confirmation poll may have refreshed the commitment.
  const proof = await assembleProof(
    isDemo() ? 'demo' : 'preprod',
    state.draw.bundle as Bundle,
    state.draw.commitment as Commitment,
    beacon,
  );
  const verdict = await verifyProof(proof, { chain: chains.koios });
  if (verdict.status === 'FAIL')
    throw new Error(
      verdict.checks
        .filter((c) => !c.passed)
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
  const verdict = await verifyProof(value, { chain: chains.koios });
  state.verifiedBundle = verdict.status === 'FAIL' ? undefined : validateProof(value).bundle;
  renderVerdict(verdict, state.verifiedBundle);
}

async function load(state: AppState, chains: Chains, read: () => Promise<unknown>) {
  renderVerificationPending();
  state.verifiedBundle = undefined;
  try {
    const loaded = await resolveArtifact(await read(), now(), chains.koios);
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
  if (!file || file.size > 8_000_000) throw new Error('Choose a JSON bundle smaller than 8 MB');
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
    if (!isDemo()) void run(state, refreshWallets);
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
