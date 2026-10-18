import type { Bundle } from '@giveaway/protocol';
import type { CheckResult, Verdict } from '@giveaway/verifier';
import type { Artifact } from './services.ts';

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
  show(['commit-preview', 'commit', 'confirm', 'late', 'open', 'result', 'winner-result', 'share-link'], false);
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

export function renderShare(artifact: Artifact, link: string, downloadUrl: string) {
  input('share-link').value = link;
  input('share-link').hidden = false;
  el('share').hidden = false;
  // Also expose pre-round sharing before the winner result is visible.
  if (artifact.format === 'giveaway-pending-2') {
    el('result').hidden = false;
    text(
      'result-note',
      'Publish this commitment link or hosted announcement before the round. A result bundle will be available after opening.',
    );
  }
  const download = el<HTMLAnchorElement>('download');
  download.href = downloadUrl;
  download.hidden = false;
  download.download = `draw-${artifact.bundle.drawId}.json`;
  download.textContent =
    artifact.format === 'giveaway-pending-2' ? '↓ Download commitment announcement' : '↓ Download verification bundle';
  if (!input('share-link').value) {
    input('share-link').placeholder =
      'Bundle too large for an inline link. Download, host publicly, then load its URL below.';
  }
}

export function renderHostedShare(link: string) {
  input('share-link').value = link;
  input('share-link').hidden = false;
  el('result').hidden = false;
  el('share').hidden = false;
  el('download').hidden = true;
  text('result-note', 'Verification link pins this hosted file’s SHA-256 hash.');
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
    el('checks').append(li);
  }
}

export function renderVerificationPending() {
  text('verification', 'Checking…');
  el('checks').replaceChildren();
  el('verified-result').hidden = true;
  el('verification').classList.remove('error');
}

export function renderVerificationNote(message: string, error = false) {
  text('verification', message);
  if (error) el('verification').classList.add('error');
}
