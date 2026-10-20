import { type Bundle, roundTime } from '@giveaway/protocol';
import { type CheckResult, UNIQUENESS_CHECK, type Verdict } from '@giveaway/verifier';
import type { ServerDraftInfo } from './drafts.ts';
import type { Artifact, Tip } from './services.ts';
import type { AppState, Mode } from './state.ts';

// DOM reads and writes only; element ids are the contract with index.html and the browser check. Which controls of
// the draw panel are shown follows from the state alone (`renderFlow`, plan step 12); the other functions write content.

export const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const input = (id: string) => el<HTMLInputElement>(id);
export const text = (id: string, value: string) => {
  el(id).textContent = value;
};
export const localTime = (seconds: number) => new Date(seconds * 1000).toLocaleString();

export function status(message: string, error = false) {
  text('draw-status', message);
  el('draw-status').classList.toggle('error', error);
}

// Disables every button and enabled form field; the returned function restores them (the round stays disabled in
// demo mode, which uses the recorded round).
export function lockControls(): (mode: Mode) => void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')];
  const fields = [
    ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      '#draw-form input, #draw-form select, #draw-form textarea',
    ),
  ].filter((f) => !f.disabled);
  for (const control of [...buttons, ...fields]) control.disabled = true;
  return (mode) => {
    for (const control of [...buttons, ...fields]) control.disabled = false;
    input('round').disabled = mode === 'demo';
  };
}

const show = (id: string, visible: boolean) => {
  el(id).hidden = !visible;
};

// The draw panel as the state says it stands: the mode's fields, the step markers, the one next action of the flow,
// the hosting actions and the share area. Called after every change of the state, and on load to restore a draft.
export function renderFlow(state: AppState) {
  const demo = state.mode === 'demo';
  const { stage, draw } = state;
  const confirmedOrLater = stage === 'confirmed' || stage === 'revealed';
  el<HTMLSelectElement>('network').value = state.mode;
  show('wallet-area', !demo);
  if (!state.busy) input('round').disabled = demo;
  show('commit-preview', stage !== 'setup');
  show('commit', stage === 'previewed');
  text('commit', demo ? 'Commit demo draw' : 'Sign and submit to preprod');
  show('confirm', stage === 'committed');
  text('confirm', demo ? 'Simulate 15 confirmations' : 'Check confirmations');
  show('late', stage === 'committed' && demo);
  show('open', stage === 'confirmed');
  // Hosting needs a confirmed on-chain commitment (BR-06); a demo draw has none.
  show('host', confirmedOrLater && !demo && draw.hosted === undefined);
  show('extend-hosting', draw.hosted !== undefined && draw.hosted.extensionsLeft !== 0);
  show('delete-hosted', draw.hosted !== undefined);
  show('winner-result', stage === 'revealed');
  show('result', state.sharing !== undefined);
  show('share-link', state.sharing !== undefined);
  show('share', state.sharing !== undefined);
  // A loaded verification link offers no download: its files are wherever the link points.
  show('download', state.sharing === 'draw');
  show('download-bundle', state.sharing === 'draw');
  el('stage-prepare').classList.toggle('done', stage !== 'setup');
  el('stage-commit').classList.toggle('done', confirmedOrLater);
  el('stage-result').classList.toggle('done', stage === 'revealed');
  renderServerDrafts(state.serverDrafts);
}

export function renderMode(mode: Mode, round: number) {
  input('round').value = String(round);
  text(
    'mode-note',
    mode === 'demo'
      ? 'Demo uses a recorded, cryptographically verified drand beacon and simulated chain timing. It is not an on-chain giveaway.'
      : 'Commit on preprod at least 30 minutes before the selected round. Fifteen confirmations must arrive before that round; the timing rule is a development default.',
  );
  status(
    mode === 'demo'
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

// What a hosted link covers: the backend keeps a bundle 12 months from the earlier of its round and its first hosting
// (ADR 2026-10-18-wallet-auth-and-bounded-retention, Amendment 5), so a round further away than that outlives the link.
export function hostedReach(hostedUntil: number, round: number): string {
  return hostedUntil > roundTime(round)
    ? `The bundle is hosted until ${localTime(hostedUntil)}, so the link shows the winners once the round arrives.`
    : `The bundle is hosted only until ${localTime(hostedUntil)}, before the round (${localTime(roundTime(round))}): a hosted link would stop working then, so it is not offered: publish the downloaded bundle file at an HTTPS URL and share that link (source) instead, or extend the hosting (12 months each, up to 36 months).`;
}
export function renderShare(
  artifact: Artifact,
  link: string,
  downloads: { artifact: string; bundle: string },
  hostedUntil?: number,
) {
  input('share-link').value = link;
  // Pre-round sharing is shown before the winner result (renderFlow shows the share area).
  if (artifact.format === 'giveaway-pending-2') {
    text(
      'result-note',
      hostedUntil === undefined
        ? 'Publish this commitment link or hosted announcement before the round. A result bundle will be available after opening.'
        : `Publish this verification link before the round. ${hostedReach(hostedUntil, artifact.bundle.drand.round)} Keep the downloaded bundle file.`,
    );
  }
  const name = artifact.format === 'giveaway-pending-2' ? 'announcement' : 'proof';
  const download = el<HTMLAnchorElement>('download');
  download.href = downloads.artifact;
  download.download = `${artifact.bundle.drawId}.${name}.json`;
  download.textContent =
    artifact.format === 'giveaway-pending-2' ? '↓ Download commitment announcement' : '↓ Download verification proof';
  // The canonical bundle bytes, named for the CLI's bundle mode (`--tx`) and for hosting anywhere.
  const bundle = el<HTMLAnchorElement>('download-bundle');
  bundle.href = downloads.bundle;
  bundle.download = `${artifact.bundle.drawId}.bundle.json`;
  if (!input('share-link').value) {
    input('share-link').placeholder =
      'Bundle too large for an inline link. Host it (preprod) or publish the bundle file at an HTTPS URL and load it below.';
  }
}

export function renderHostedShare(link: string) {
  input('share-link').value = link;
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

// The signer's server drafts as last listed (plan step 12): a choice of draft to load or delete, newest first.
function renderServerDrafts(drafts: ServerDraftInfo[] | undefined) {
  const select = el<HTMLSelectElement>('server-draft');
  const shown = [...select.options].map((o) => o.value).join();
  const wanted = (drafts ?? []).map((d) => d.id).join();
  if (shown !== wanted) {
    select.replaceChildren();
    for (const draft of drafts ?? []) {
      const option = document.createElement('option');
      option.value = draft.id;
      option.textContent = `Saved ${localTime(draft.savedAt)} · kept until ${localTime(draft.expiresAt)}`;
      select.append(option);
    }
  }
  show('server-draft-pick', (drafts ?? []).length > 0);
}

export function draftNote(message: string) {
  text('draft-note', message);
}
