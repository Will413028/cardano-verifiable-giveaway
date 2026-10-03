import { VERSION, ALGORITHM, QUICKNET, BOUNDARY, CONFIRMATIONS, computeCommitment,
  normalizeLabel, parseEntrants, validateBundle, validateProof, selectWinners, roundTime, roundAt,
  checkTiming, sha256, type Bundle, type Commitment, type Proof } from '../../packages/protocol/index.ts';
import { FIXTURE, fetchBeacon } from '../../packages/beacon/index.ts';
import { DemoChain, KoiosChain } from '../../packages/chain/index.ts';
import { verifyProof } from '../../packages/protocol/verifier.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const text = (id: string, value: string) => { el(id).textContent = value; };
let bundle: Bundle | undefined, commitment: Commitment | undefined, proof: Proof | undefined;
let transaction: Awaited<ReturnType<typeof import('./cardano.ts').prepareTransaction>> | undefined;
const demo = new DemoChain();
let busy = false, poll: ReturnType<typeof setTimeout> | undefined, downloadUrl = '';
let verifiedBundle: Bundle | undefined;
const isDemo = () => input('network').value === 'demo';
function status(message: string, error = false) { text('draw-status', message); el('draw-status').classList.toggle('error', error); }
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('#draw-form input, #draw-form select, #draw-form textarea')].filter(f => !f.disabled);
  buttons.forEach(b => { b.disabled = true; });
  fields.forEach(f => { f.disabled = true; });
  try { await action(); } catch (e) { status((e as Error).message, true); }
  finally { busy = false; buttons.forEach(b => { b.disabled = false; }); fields.forEach(f => { f.disabled = false; }); input('round').disabled = isDemo(); }
}
function reset() {
  clearTimeout(poll); bundle = undefined; commitment = undefined; proof = undefined; transaction = undefined;
  for (const id of ['commit-preview', 'commit', 'confirm', 'late', 'open', 'result', 'winner-result', 'share-link']) el(id).hidden = true;
  for (const id of ['stage-prepare', 'stage-commit', 'stage-result']) el(id).classList.remove('done');
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
}
function updateMode() {
  reset(); el('wallet-area').hidden = isDemo(); input('round').disabled = isDemo();
  input('round').value = String(isDemo() ? FIXTURE.round : roundAt(Date.now() / 1000 + 1860));
  text('mode-note', isDemo() ? 'Demo uses a recorded, cryptographically verified drand beacon and simulated chain timing. It is not an on-chain giveaway.' : 'Commit on preprod at least 30 minutes before the selected round. Fifteen confirmations must arrive before that round; the timing rule is a development default.');
  status(isDemo() ? 'No wallet needed. Preview your demo draw to begin.' : 'Preprod integration is implemented but real-wallet acceptance is deferred.');
}
async function refreshWallets() {
  const { wallets } = await import('./cardano.ts'); const available = wallets();
  const select = el<HTMLSelectElement>('wallet'); select.replaceChildren();
  for (const w of available) { const option = document.createElement('option'); option.value = w.id; option.textContent = w.name; select.append(option); }
  if (!available.length) status('No CIP-30 wallet detected in this browser profile. Demo mode works without one.');
}
input('network').onchange = () => { updateMode(); if (!isDemo()) void run(refreshWallets); };
el('refresh-wallets').onclick = () => void run(refreshWallets);
input('entrants').oninput = () => {
  try { text('entrant-count', `${parseEntrants(input('entrants').value).length} participants`); }
  catch (e) { text('entrant-count', (e as Error).message); }
};
input('csv').onchange = () => void run(async () => {
  const file = input('csv').files?.[0]; if (!file) return;
  if (file.size > 2_000_000) throw new Error('CSV exceeds 2 MB');
  const labels = parseEntrants(await file.text());
  input('entrants').value = labels.join('\n'); text('entrant-count', `${labels.length} participants`);
  status('Imported public labels. Other CSV columns were discarded.');
});
el('draw-form').onsubmit = event => {
  event.preventDefault(); void run(async () => {
    reset();
    const round = Number(input('round').value);
    if (!isDemo() && roundTime(round) < Date.now() / 1000 + 1800) throw new Error('Choose a round at least 30 minutes in the future');
    bundle = validateBundle({ version: VERSION, algorithm: ALGORITHM, drawId: crypto.randomUUID(),
      entrants: parseEntrants(input('entrants').value).map(normalizeLabel), rules: { winners: Number(input('winner-count').value) },
      drand: { chainHash: QUICKNET, round } });
    text('preview-count', String(bundle.entrants.length)); text('preview-winners', String(bundle.rules.winners));
    text('preview-hash', await computeCommitment(bundle));
    text('preview-time', isDemo() ? 'Recorded quicknet round · simulated timing' : new Date(roundTime(round) * 1000).toLocaleString());
    if (!isDemo()) {
      const { prepareTransaction } = await import('./cardano.ts');
      transaction = await prepareTransaction(bundle, input('wallet').value);
      status(`Ready to sign. Estimated fee: ${transaction.fee.toFixed(6)} test ADA. The transaction returns the transferred ADA to your wallet.`);
    } else status('List and rules locked in the preview. Commit the demo draw next.');
    el('commit-preview').hidden = false; el('commit').hidden = false;
    text('commit', isDemo() ? 'Commit demo draw' : 'Sign and submit to preprod');
    el('stage-prepare').classList.add('done');
  });
};
el('commit').onclick = () => void run(async () => {
  if (!bundle) throw new Error('Preview a draw first');
  if (isDemo()) commitment = await demo.commit(bundle);
  else {
    if (!transaction) throw new Error('Build a transaction first');
    const txHash = await transaction.signAndSubmit();
    commitment = { txHash, owner: transaction.owner, bundleHash: await computeCommitment(bundle), drawId: bundle.drawId,
      round: bundle.drand.round, blockHeight: 0, blockTime: 0, confirmedAt: 0 };
  }
  el('commit').hidden = true; el('confirm').hidden = false; el('late').hidden = !isDemo();
  text('confirm', isDemo() ? 'Simulate 15 confirmations' : 'Check confirmations');
  status(isDemo() ? 'Demo commitment created. Simulate confirmations to continue.' : `Submitted ${commitment.txHash}. Publish the commitment link before the round. Waiting for ${CONFIRMATIONS} confirmations.`);
  // A pre-round link is available immediately. It identifies the committed bundle and reference.
  showShare({ format: 'giveaway-pending-1', network: isDemo() ? 'demo' : 'preprod', bundle, commitment });
  if (!isDemo()) scheduleConfirmation();
});
function scheduleConfirmation() {
  clearTimeout(poll); poll = setTimeout(async () => {
    if (!bundle || !commitment || isDemo()) return;
    try { await confirm(); } catch (e) { status(`${(e as Error).message}. Next check in 30 seconds.`); if (Date.now() / 1000 < roundTime(bundle.drand.round)) scheduleConfirmation(); else status('Round has arrived without verified confirmations. This draw is invalid; create a new drawId.', true); }
  }, 30000);
}
async function confirm(late = false) {
  if (!bundle || !commitment) throw new Error('Commit a draw first');
  commitment = isDemo() ? demo.confirm(commitment, late) : await new KoiosChain().readCommitment(commitment.txHash, commitment.owner);
  if (!checkTiming(commitment, bundle.drand.round)) { el('open').hidden = true; el('confirm').hidden = true; el('late').hidden = true; clearTimeout(poll); throw new Error('Confirmation arrived too late. This draw is invalid; create a new drawId.'); }
  clearTimeout(poll); el('stage-commit').classList.add('done'); el('confirm').hidden = true; el('late').hidden = true; el('open').hidden = false;
  status(isDemo() ? 'Demo confirms before the recorded round. You can reveal the winners.' : `Fifteen confirmations verified. Round starts at ${new Date(roundTime(bundle.drand.round) * 1000).toLocaleString()}.`);
}
el('confirm').onclick = () => void run(() => confirm());
el('late').onclick = () => void run(() => confirm(true));
el('open').onclick = () => void run(async () => {
  if (!bundle || !commitment || !checkTiming(commitment, bundle.drand.round)) throw new Error('Need valid confirmation timing');
  if (!isDemo() && Date.now() / 1000 < roundTime(bundle.drand.round)) throw new Error(`Round is not available yet. Starts at ${new Date(roundTime(bundle.drand.round) * 1000).toLocaleString()}.`);
  const beacon = isDemo() ? FIXTURE : await fetchBeacon(bundle.drand.round);
  proof = { format: 'giveaway-proof-1', network: isDemo() ? 'demo' : 'preprod', bundle, commitment,
    beacon, winners: await selectWinners(bundle, beacon.randomness) };
  const verdict = await verifyProof(proof);
  if (verdict.status === 'FAIL') throw new Error(verdict.checks.filter(c => !c.passed).map(c => c.detail).join('; '));
  const winners = el('winners'); winners.replaceChildren();
  for (const label of verdict.winners) { const li = document.createElement('li'); li.textContent = label; winners.append(li); }
  el('result').hidden = false; el('winner-result').hidden = false; el('open').hidden = true; el('stage-result').classList.add('done');
  status(verdict.status === 'DEMO PASS' ? 'Demo complete. Chain evidence is simulated; drand signature and winners are independently checked.' : 'Draw opened. Independent verification passed.');
  text('result-note', verdict.status === 'DEMO PASS' ? 'DEMO · Recorded randomness, simulated commitment timing. Not an on-chain fairness claim.' : 'Publish the bundle so participants can independently verify it.');
  showShare(proof); await renderVerification(proof);
});
function showShare(artifact: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(artifact));
  let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const link = new URL(location.href); link.hash = `proof=${encoded}`; link.search = '';
  input('share-link').value = encoded.length <= 12000 ? link.toString() : '';
  input('share-link').hidden = false; el('share').hidden = false;
  // Also expose pre-round sharing before the winner result is visible.
  if ((artifact as any).format === 'giveaway-pending-1') { el('result').hidden = false; text('result-note', 'Publish this commitment link or hosted announcement before the round. A result bundle will be available after opening.'); }
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' }));
  const download = el<HTMLAnchorElement>('download'); download.href = downloadUrl; download.hidden = false;
  download.download = `draw-${(artifact as any).bundle.drawId}.json`;
  download.textContent = (artifact as any).format === 'giveaway-pending-1' ? '↓ Download commitment announcement' : '↓ Download verification bundle';
  if (!input('share-link').value) { input('share-link').placeholder = 'Bundle too large for an inline link. Download, host publicly, then load its URL below.'; }
}
el('share').onclick = () => void run(async () => {
  const value = input('share-link').value;
  if (!value) throw new Error('Host the downloaded bundle publicly and load its HTTPS URL to create a share link');
  try { await navigator.clipboard.writeText(value); status('Verification link copied.'); }
  catch { input('share-link').focus(); input('share-link').select(); status('Select and copy the verification link.'); }
});
async function renderVerification(value: unknown) {
  const verdict = await verifyProof(value);
  verifiedBundle = verdict.status === 'FAIL' ? undefined : validateProof(value).bundle;
  el('verified-result').hidden = !verifiedBundle;
  el('verified-winners').replaceChildren(); el('verified-labels').replaceChildren();
  if (verifiedBundle) {
    for (const [id, labels] of [['verified-winners', verdict.winners], ['verified-labels', verifiedBundle.entrants]] as const) {
      for (const label of labels) { const li = document.createElement('li'); li.textContent = label; el(id).append(li); }
    }
    text('labels-summary', `${verifiedBundle.entrants.length} public labels`); lookup();
  }
  text('verification', verdict.status); el('verification').classList.toggle('error', verdict.status === 'FAIL');
  el('checks').replaceChildren();
  for (const check of verdict.checks) {
    const li = document.createElement('li'); li.classList.toggle('error', !check.passed);
    li.textContent = `${check.passed ? '✓' : '×'} ${check.name}`;
    const detail = document.createElement('small'); detail.textContent = check.detail; li.append(detail); el('checks').append(li);
  }
}
function lookup() {
  if (!verifiedBundle) return;
  const label = input('lookup').value.trim().normalize('NFC');
  text('lookup-result', !label ? 'Enter your label to check list membership.' : verifiedBundle.entrants.includes(label) ? 'Your label is in this bundle. This does not establish eligibility.' : 'Your label is not in this bundle.');
}
input('lookup').oninput = lookup;
async function loadArtifact(value: unknown) {
  if ((value as any)?.format === 'giveaway-pending-1') {
    const pending = value as { network: string; bundle: Bundle; commitment: Commitment };
    const b = validateBundle(pending.bundle);
    if (pending.network !== 'preprod') { text('verification', 'DEMO COMMITMENT — simulated evidence. Open the draw to share a complete result bundle.'); return; }
    if (Date.now() / 1000 < roundTime(b.drand.round)) { text('verification', `Commitment announced. Awaiting round ${b.drand.round}. Chain evidence is checked when the complete result is loaded.`); return; }
    const c = await new KoiosChain().readCommitment(pending.commitment.txHash, pending.commitment.owner);
    const beacon = await fetchBeacon(b.drand.round);
    return renderVerification({ format: 'giveaway-proof-1', network: 'preprod', bundle: b, commitment: c,
      beacon, winners: await selectWinners(b, beacon.randomness) });
  }
  validateProof(value); await renderVerification(value);
}
async function safeLoad(action: () => Promise<unknown>) {
  text('verification', 'Checking…'); el('checks').replaceChildren();
  el('verified-result').hidden = true; verifiedBundle = undefined; el('verification').classList.remove('error');
  try { await loadArtifact(await action()); }
  catch (e) { text('verification', `FAIL: ${(e as Error).message}`); el('verification').classList.add('error'); }
}
input('proof-file').onchange = () => void safeLoad(async () => {
  const file = input('proof-file').files?.[0]; if (!file || file.size > 8_000_000) throw new Error('Choose a JSON bundle smaller than 8 MB');
  return JSON.parse(await file.text());
});
async function loadUrl(url: string, expectedHash?: string) {
  const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Use a public HTTPS URL without credentials');
  const response = await fetch(parsed, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Bundle host: HTTP ${response.status}`);
  const body = await response.text(); if (new TextEncoder().encode(body).length > 8_000_000) throw new Error('Bundle exceeds 8 MB');
  const hash = await sha256(body); if (expectedHash && hash !== expectedHash) throw new Error('Hosted bundle hash does not match the verification link');
  const share = new URL(location.href); share.hash = ''; share.search = new URLSearchParams({ bundle: parsed.toString(), hash }).toString();
  input('share-link').value = share.toString(); input('share-link').hidden = false;
  el('result').hidden = false; el('share').hidden = false; el('download').hidden = true;
  text('result-note', 'Verification link pins this hosted file’s SHA-256 hash.');
  return JSON.parse(body);
}
el('load-url').onclick = () => void safeLoad(() => loadUrl(input('bundle-url').value));
text('boundary', BOUNDARY); updateMode();
window.addEventListener('beforeunload', () => { clearTimeout(poll); if (downloadUrl) URL.revokeObjectURL(downloadUrl); });
const query = new URLSearchParams(location.search);
if (location.hash.startsWith('#proof=')) void safeLoad(async () => {
  const encoded = location.hash.slice(7); if (encoded.length > 16000) throw new Error('Inline bundle too large');
  const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
});
else if (query.has('bundle')) void safeLoad(() => loadUrl(query.get('bundle')!, query.get('hash') ?? undefined));
