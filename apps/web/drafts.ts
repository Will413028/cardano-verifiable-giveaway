import {
  BUNDLE_BYTE_LIMIT,
  type Draft,
  type DraftOperationName,
  draftOperationText,
  hex,
  labelsText,
  parseEntrants,
  sha256,
  validateDraft,
} from '@giveaway/protocol';
import { API_URL, fetchNonce, type OwnerSigner, signedAuthorization } from './services.ts';

// Draft saving (plan step 12; BR-11, BR-12, BR-18). DOM-free: the draft format, the browser's copy (IndexedDB), the
// exported file and the backend's signed server drafts. A draft is the setup form before anything is committed: the
// mode, the participant text, the number of winners and the round. It is never a bundle, an announcement or a proof
// and never enters the verification flow: its own format, refused by validateProof, and only the setup form reads it.

// The draft format lives in @giveaway/protocol, so the backend refuses anything else as a server draft.
export { DRAFT_FORMAT, type Draft, validateDraft } from '@giveaway/protocol';

// The exported file: the draft as JSON, which importDraft reads back to the same draft.
export const exportDraft = (draft: Draft) => `${JSON.stringify(validateDraft(draft), null, 2)}\n`;
export function importDraft(text: string): Draft {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('This file is not an Open Draw draft (not JSON).');
  }
  return validateDraft(value);
}

// The browser's copy (BR-11): one current draft per browser profile, kept by IndexedDB until the visitor clears site
// data. Necessity condition: the page is static and its form is lost on reload; without a store in the browser,
// restoring after a reload would need the backend, which the ADR keeps optional. `serverId` is the server draft the
// local one was last saved to, so saving again replaces it instead of using up the quota.
export interface LocalDraft {
  draft: Draft;
  savedAt: number;
  serverId?: string;
}
const DB_NAME = 'open-draw';
const STORE = 'drafts';
const CURRENT = 'current';
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error ?? new Error('IndexedDB is unavailable'));
  });
}
async function transact<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
    });
  } finally {
    db.close();
  }
}
export async function readLocalDraft(): Promise<LocalDraft | undefined> {
  const stored = (await transact('readonly', (store) => store.get(CURRENT))) as LocalDraft | undefined;
  if (!stored) return undefined;
  try {
    return {
      draft: validateDraft(stored.draft),
      savedAt: Number(stored.savedAt),
      ...(typeof stored.serverId === 'string' ? { serverId: stored.serverId } : {}),
    };
  } catch {
    // A copy written by another version of the page: ignored, and replaced by the next save.
    return undefined;
  }
}
export async function writeLocalDraft(local: LocalDraft): Promise<void> {
  await transact('readwrite', (store) => store.put(local, CURRENT));
}

// Server drafts (BR-12, BR-18; apps/api/src/drafts.ts): each operation is signed on its own by the wallet's stake
// key (PD4: no session), over the draft operation text for this page, the operation, the draft and, for a save, the
// SHA-256 of the bytes. The backend keeps at most 5 per wallet identity, 30 days after their last save.
export interface ServerDraftInfo {
  id: string;
  savedAt: number;
  expiresAt: number;
  size: number;
}
export const newDraftId = () => hex(crypto.getRandomValues(new Uint8Array(16)));
// What is sent to the server: the participant field reduced to the public labels the bundle would carry (other CSV
// columns, such as contacts, never leave the browser), and the draft otherwise as it is.
export function serverCopy(draft: Draft): Draft {
  return { ...draft, entrants: labelsText(parseEntrants(draft.entrants)) };
}

async function draftRequest(
  operation: DraftOperationName,
  subject: { draft: string; content?: string },
  sign: OwnerSigner,
  init: { method: string; path: string; body?: BodyInit },
  api: string,
): Promise<Response> {
  const { nonce, issuedAt } = await fetchNonce(api);
  const text = draftOperationText({
    domain: location.host,
    operation,
    network: 'preprod',
    draft: subject.draft,
    content: subject.content ?? 'none',
    nonce,
    issuedAt,
  });
  const response = await fetch(`${api}${init.path}`, {
    method: init.method,
    body: init.body,
    headers: { Authorization: await signedAuthorization(text, sign) },
    credentials: 'omit',
    signal: AbortSignal.timeout(60000),
  });
  // The service's global draft storage is full (BR-18): nothing is lost, the browser copy and the export still work.
  if (response.status === 507)
    throw new Error(
      'Server draft storage is full right now, so this draft was not saved to the server. It is still kept in this browser, and Export draft still saves a copy.',
    );
  if (!response.ok)
    throw new Error(
      `The backend refused the draft operation (${operation}): HTTP ${response.status} (${(await response.text()).slice(0, 300)})`,
    );
  return response;
}
const info = (value: unknown): ServerDraftInfo => {
  const row = value as Partial<ServerDraftInfo> | null;
  if (
    !row ||
    typeof row.id !== 'string' ||
    !Number.isSafeInteger(row.savedAt) ||
    !Number.isSafeInteger(row.expiresAt) ||
    !Number.isSafeInteger(row.size)
  )
    throw new Error('Server draft: unexpected response');
  return row as ServerDraftInfo;
};

export async function saveServerDraft(
  id: string,
  draft: Draft,
  sign: OwnerSigner,
  api = API_URL,
): Promise<ServerDraftInfo> {
  const bytes = new TextEncoder().encode(exportDraft(serverCopy(draft)));
  if (bytes.length > BUNDLE_BYTE_LIMIT) throw new Error(`Draft exceeds ${BUNDLE_BYTE_LIMIT} bytes`);
  const response = await draftRequest(
    'draft-save',
    { draft: id, content: await sha256(bytes) },
    sign,
    { method: 'PUT', path: `/drafts/${id}`, body: bytes },
    api,
  );
  return info(await response.json());
}
export async function listServerDrafts(sign: OwnerSigner, api = API_URL): Promise<ServerDraftInfo[]> {
  const response = await draftRequest('draft-list', { draft: 'all' }, sign, { method: 'GET', path: '/drafts' }, api);
  const body = await response.json();
  if (!Array.isArray(body?.drafts)) throw new Error('Server draft: unexpected response');
  return body.drafts.map(info);
}
export async function loadServerDraft(id: string, sign: OwnerSigner, api = API_URL): Promise<Draft> {
  const response = await draftRequest('draft-load', { draft: id }, sign, { method: 'GET', path: `/drafts/${id}` }, api);
  return importDraft(await response.text());
}
export async function deleteServerDraft(id: string, sign: OwnerSigner, api = API_URL): Promise<void> {
  await draftRequest('draft-delete', { draft: id }, sign, { method: 'DELETE', path: `/drafts/${id}` }, api);
}
