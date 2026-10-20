import {
  type Draft,
  DRAFT_FORMAT,
  deleteServerDraft,
  exportDraft,
  importDraft,
  type LocalDraft,
  listServerDrafts,
  loadServerDraft,
  newDraftId,
  readLocalDraft,
  saveServerDraft,
  writeLocalDraft,
} from './drafts.ts';
import type { OwnerSigner } from './services.ts';
import type { AppState, Mode } from './state.ts';
import { draftNote, el, input, localTime, renderFlow, status } from './view.ts';

// The setup form's drafts (plan step 12; BR-11, BR-12): every edit is kept in this browser and restored on the next
// load; the draft can be exported to a file and imported back, and on preprod saved to and loaded from the backend
// under the wallet's signature. A draft fills only the setup form (mode, participants, winners, round): it never
// reaches the verification panel, and loading one starts a new draw like changing the mode does.

export interface DraftFlow {
  // app.ts: run an action with the controls locked and render afterwards; switch mode (a new draw), with the round to
  // show; the preprod side effects of a mode switch (tip, wallets).
  run: (state: AppState, action: () => Promise<void>, options?: { queue?: boolean }) => Promise<void>;
  setMode: (state: AppState, mode: Mode, round?: number) => void;
  enterPreprod: (state: AppState) => Promise<void>;
}

const formDraft = (state: AppState): Draft => ({
  format: DRAFT_FORMAT,
  mode: state.mode,
  entrants: input('entrants').value,
  winners: input('winner-count').value,
  round: input('round').value,
});

const time = (seconds: number) => localTime(seconds);
const nowSeconds = () => Math.floor(Date.now() / 1000);

// Wires the draft controls and restores the kept draft; resolves once the restore is done, so a link the page was
// opened with is loaded after it (a restore starts a new draw and would clear what the link showed).
export function wireDrafts(state: AppState, flow: DraftFlow): Promise<void> {
  // Writes are queued, so the stored draft is always the last edit, whatever IndexedDB's timing.
  let queue: Promise<void> = Promise.resolve();
  // While a draft is being filled in, its own field events are not edits.
  let filling = false;
  const keep = () => {
    if (filling) return;
    const local: LocalDraft = {
      draft: formDraft(state),
      savedAt: nowSeconds(),
      ...(state.serverDraftId ? { serverId: state.serverDraftId } : {}),
    };
    queue = queue
      .then(() => writeLocalDraft(local))
      .then(
        () => draftNote(`Draft kept in this browser (${time(local.savedAt)}). It is restored when you come back.`),
        (e) => draftNote(`This browser did not keep the draft (${(e as Error).message}). Export it to keep a copy.`),
      );
  };
  // The form, filled from a draft, and the mode it was written in (a new draw in that mode).
  // A loaded draft starts a new draw; a draw already committed is not discarded that way (its announcement and the
  // confirmation checks would go with it). Changing the mode remains the explicit way to start over.
  const replaceable = () => state.stage === 'setup' || state.stage === 'previewed';
  const requireReplaceable = () => {
    if (!replaceable())
      throw new Error(
        'A committed draw is in progress: loading a draft would discard it. Switch the mode to start a new draw first.',
      );
  };
  const fill = async (draft: Draft) => {
    requireReplaceable();
    filling = true;
    try {
      flow.setMode(state, draft.mode, draft.round ? Number(draft.round) : undefined);
      input('entrants').value = draft.entrants;
      // The participant count follows the field (app.ts).
      input('entrants').dispatchEvent(new Event('input'));
      input('winner-count').value = draft.winners;
    } finally {
      filling = false;
    }
    if (draft.mode === 'preprod') await flow.enterPreprod(state);
    renderFlow(state);
  };

  for (const id of ['entrants', 'winner-count', 'round']) input(id).addEventListener('input', keep);
  input('network').addEventListener('change', keep);

  el('export-draft').onclick = () => {
    const url = URL.createObjectURL(new Blob([exportDraft(formDraft(state))], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'open-draw-draft.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('Draft exported. Import it here, on any browser, to continue.');
  };
  input('import-draft').onchange = () =>
    void flow.run(
      state,
      async () => {
        requireReplaceable();
        const file = input('import-draft').files?.[0];
        input('import-draft').value = '';
        if (!file) return;
        if (file.size > 4_000_000) throw new Error('Draft file exceeds 4 MB');
        const draft = importDraft(await file.text());
        state.serverDraftId = undefined;
        await fill(draft);
        keep();
        status('Draft imported. Preview the draw when it is ready.');
      },
      { queue: true },
    );

  // Server drafts: signed by the wallet chosen in the preprod wallet field.
  const signer: OwnerSigner = async (text) => {
    const { signDraftOperation } = await import('./cardano.ts');
    return signDraftOperation(input('wallet').value, text);
  };
  el('save-server-draft').onclick = () =>
    void flow.run(state, async () => {
      const id = state.serverDraftId ?? newDraftId();
      const saved = await saveServerDraft(id, formDraft(state), signer);
      state.serverDraftId = id;
      keep();
      status(
        `Draft saved to the server (public labels only) until ${time(saved.expiresAt)}: kept 30 days after each save, at most 5 per wallet.`,
      );
    });
  el('list-server-drafts').onclick = () =>
    void flow.run(state, async () => {
      state.serverDrafts = await listServerDrafts(signer);
      status(
        state.serverDrafts.length
          ? `${state.serverDrafts.length} server draft(s) for this wallet. Choose one to load or delete.`
          : 'This wallet keeps no server drafts.',
      );
    });
  el('load-server-draft').onclick = () =>
    void flow.run(state, async () => {
      const id = input('server-draft').value;
      if (!id) throw new Error('List the server drafts and choose one first');
      requireReplaceable();
      const draft = await loadServerDraft(id, signer);
      state.serverDraftId = id;
      await fill(draft);
      keep();
      status('Server draft loaded into the form.');
    });
  el('delete-server-draft').onclick = () =>
    void flow.run(state, async () => {
      const id = input('server-draft').value;
      if (!id) throw new Error('List the server drafts and choose one first');
      await deleteServerDraft(id, signer);
      state.serverDrafts = state.serverDrafts?.filter((d) => d.id !== id);
      if (state.serverDraftId === id) {
        state.serverDraftId = undefined;
        keep();
      }
      status('Server draft deleted.');
    });

  // Restore: the draft this browser kept, if any, replaces the defaults.
  return readLocalDraft().then(
    (local) => {
      // Nothing kept, or the visitor already started a draw while it was being read.
      if (!local || !replaceable() || state.busy) return;
      state.serverDraftId = local.serverId;
      void fill(local.draft);
      draftNote(`Restored the draft kept in this browser (${time(local.savedAt)}).`);
    },
    (e) => draftNote(`This browser keeps no drafts (${(e as Error).message}). Export the draft to keep a copy.`),
  );
}
