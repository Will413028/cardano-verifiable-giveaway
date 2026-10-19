import type { Bundle } from '@giveaway/protocol';
import { type CheckResult, UNIQUENESS_CHECK, type Verdict } from '@giveaway/verifier';
import type { Artifact, Tip } from './services.ts';

// DOM reads and writes only; element ids are the contract with index.html and the browser check.

export const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const input = (id: string) => el<HTMLInputElement>(id);
export const text = (id: string, value: string) => {
  el(id).textContent = value;
};
export const isDemo = () => input('network').value === 'demo';
export const localTime = (seconds: number) => new Date(seconds * 1000).toLocaleString();

export function status(message: string, error = false) {
  text('draw-status', message);
  el('draw-status').classList.toggle('error', error);
}

// Disables every button and enabled form field; the returned function restores them.
export function lockControls(): () => void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
  const fields = [
    ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      '#draw-form input, #draw-form select, #draw-form textarea',
    ),
  ].filter((f) => !f.disabled);
  for (const control of [...buttons, ...fields]) control.disabled = true;
  return () => {
    for (const control of [...buttons, ...fields]) control.disabled = false;
    input('round').disabled = isDemo();
  };
}

export function show(ids: string[], visible: boolean) {
  for (const id of ids) el(id).hidden = !visible;
}

export function clearDrawProgress() {
  show(['commit-preview', 'commit', 'confirm', 'late', 'open', 'host', 'result', 'winner-result', 'share-link'], false);
  for (const id of ['stage-prepare', 'stage-commit', 'stage-result']) el(id).classList.remove('done');
}

export function renderMode(round: number) {
  el('wallet-area').hidden = isDemo();
  input('round').disabled = isDemo();
  input('round').value = String(round);
  text(
    'mode-note',
    isDemo()
      ? 'Demo uses a recorded, cryptographically verified drand beacon and simulated chain timing. It is not an on-chain giveaway.'
      : 'Commit on preprod at least 30 minutes before the selected round. Fifteen confirmations must arrive before that round; the timing rule is a development default.',
  );
  status(
    isDemo()
      ? 'No wallet needed. Preview your demo draw to begin.'
      : 'Preprod integration is implemented but real-wallet acceptance is deferred.',
  );
}

export function renderTip(tip: Tip | Error) {
  text(
    'chain-tip',
    tip instanceof Error
      ? `Preprod tip unavailable from the project indexer (${tip.message}).`
      : `Preprod tip from the project indexer: block ${tip.blockHeight} · epoch ${tip.epoch} · slot ${tip.slot} · ${localTime(tip.blockTime)}`,
  );
}

export function renderWallets(available: { id: string; name: string }[]) {
  const select = el<HTMLSelectElement>('wallet');
  select.replaceChildren();
  for (const w of available) {
    const option = document.createElement('option');
    option.value = w.id;
    option.textContent = w.name;
    select.append(option);
  }
  if (!available.length) status('No CIP-30 wallet detected in this browser profile. Demo mode works without one.');
}

function renderLabels(id: string, labels: readonly string[]) {
  for (const label of labels) {
    const li = document.createElement('li');
    li.textContent = label;
    el(id).append(li);
  }
}

export function renderWinners(labels: readonly string[]) {
  el('winners').replaceChildren();
  renderLabels('winners', labels);
}

export function renderShare(
  artifact: Artifact,
  link: string,
  downloads: { artifact: string; bundle: string },
  hostedUntil?: number,
) {
  input('share-link').value = link;
  input('share-link').hidden = false;
  el('share').hidden = false;
  // Also expose pre-round sharing before the winner result is visible.
  if (artifact.format === 'giveaway-pending-2') {
    el('result').hidden = false;
    text(
      'result-note',
      hostedUntil === undefined
        ? 'Publish this commitment link or hosted announcement before the round. A result bundle will be available after opening.'
        : `Publish this verification link before the round; it shows the winners once the round arrives. The bundle is hosted until ${localTime(hostedUntil)}: keep the downloaded bundle file.`,
    );
  }
  const name = artifact.format === 'giveaway-pending-2' ? 'announcement' : 'proof';
  const download = el<HTMLAnchorElement>('download');
  download.href = downloads.artifact;
  download.hidden = false;
  download.download = `${artifact.bundle.drawId}.${name}.json`;
  download.textContent =
    artifact.format === 'giveaway-pending-2' ? '↓ Download commitment announcement' : '↓ Download verification proof';
  // The canonical bundle bytes, named for the CLI's bundle mode (`--tx`) and for hosting anywhere.
  const bundle = el<HTMLAnchorElement>('download-bundle');
  bundle.href = downloads.bundle;
  bundle.hidden = false;
  bundle.download = `${artifact.bundle.drawId}.bundle.json`;
  if (!input('share-link').value) {
    input('share-link').placeholder =
      'Bundle too large for an inline link. Host it (preprod) or publish the bundle file at an HTTPS URL and load it below.';
  }
}

export function renderHostedShare(link: string) {
  input('share-link').value = link;
  input('share-link').hidden = false;
  el('result').hidden = false;
  el('share').hidden = false;
  show(['download', 'download-bundle'], false);
  text('result-note', 'Verification link: the commitment transaction and the SHA-256 hash of the bundle it committed.');
}

export function renderLookup(bundle: Bundle | undefined) {
  if (!bundle) return;
  const label = input('lookup').value.trim().normalize('NFC');
  text(
    'lookup-result',
    !label
      ? 'Enter your label to check list membership.'
      : bundle.entrants.includes(label)
        ? 'Your label is in this bundle. This does not establish eligibility.'
        : 'Your label is not in this bundle.',
  );
}

const CHECK_MARK: Record<CheckResult, string> = { pass: '✓', fail: '×', unevaluated: '–' };

export function renderVerdict(verdict: Verdict, bundle: Bundle | undefined) {
  el('verified-result').hidden = !bundle;
  el('verified-winners').replaceChildren();
  el('verified-labels').replaceChildren();
  if (bundle) {
    renderLabels('verified-winners', verdict.winners);
    renderLabels('verified-labels', bundle.entrants);
    text('labels-summary', `${bundle.entrants.length} public labels`);
    renderLookup(bundle);
  }
  text('verification', verdict.status);
  el('verification').classList.toggle('error', verdict.status === 'FAIL');
  el('checks').replaceChildren();
  for (const check of verdict.checks) {
    const li = document.createElement('li');
    li.classList.toggle('error', check.result === 'fail');
    li.classList.toggle('unevaluated', check.result === 'unevaluated');
    li.textContent = `${CHECK_MARK[check.result]} ${check.name}`;
    const detail = document.createElement('small');
    detail.textContent = check.detail;
    li.append(detail);
    if (check.name === UNIQUENESS_CHECK && verdict.conflicts.length) {
      const list = document.createElement('ul');
      for (const c of verdict.conflicts) {
        const item = document.createElement('li');
        item.textContent = `${c.txHash} · drawId ${c.drawId} · round ${c.round} · included ${localTime(c.blockTime)}`;
        list.append(item);
      }
      li.append(list);
    }
    el('checks').append(li);
  }
}

// Where the verdict's chain evidence came from (BR-16): the indexer URL that was read, or that it was simulated.
export function renderEvidenceSource(source: { indexer: string; own: boolean } | 'demo' | null) {
  text(
    'evidence-source',
    source === null
      ? ''
      : source === 'demo'
        ? 'Chain evidence source: simulated (demo). No indexer was read.'
        : `Chain evidence source: ${source.indexer} (${source.own ? 'the indexer you named' : 'the project indexer'}). The result depends on what this indexer reports.`,
  );
}

export function renderVerificationPending() {
  text('verification', 'Checking…');
  text('evidence-source', '');
  el('checks').replaceChildren();
  el('verified-result').hidden = true;
  el('verification').classList.remove('error');
}

export function renderVerificationNote(message: string, error = false) {
  text('verification', message);
  if (error) el('verification').classList.add('error');
}
