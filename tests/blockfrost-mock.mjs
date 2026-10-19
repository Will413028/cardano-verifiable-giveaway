// A Blockfrost-shaped indexer over a fixed set of transactions, answering the way Dolos 1.6.1 MiniBF answered on the
// dev chain. Status codes, error bodies and headers are copied from the recorded responses
// (docs/plans/2026-10-18-hardening-and-backend/dolos-1.6.1-*captures.json), not written here: a route the node lacks
// is 404 with an empty body, an unknown address or account 404 JSON, an unknown transaction 404 empty, a page past
// the end 200 [], count over 100 and page × count over max_scan_items 400, a block not produced yet 400. Shared by
// the Node tests (`fetch`) and the browser check (`answer`, for Playwright's route.fulfill).
import { readFileSync } from 'node:fs';
import { CONFIRMATIONS, decodeBech32, encodeBech32, hex, identityOf } from '@giveaway/verifier-cli/library';

const recorded = (name) =>
  JSON.parse(readFileSync(new URL(`../docs/plans/2026-10-18-hardening-and-backend/${name}`, import.meta.url), 'utf8'));
const SPIKE = recorded('dolos-1.6.1-captures.json');
const ADAPTER = recorded('dolos-1.6.1-adapter-captures.json');
// The headers every Dolos answer carried, error or not (CORS: permissive_cors, the 1.6.1 default).
const COMMON = Object.fromEntries(
  ['access-control-allow-origin', 'access-control-expose-headers', 'vary'].map((h) => [
    h,
    SPIKE['unknown-tx'].headers[h],
  ]),
);
const PREFLIGHT = Object.fromEntries(
  ['access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-origin', 'allow', 'vary'].map(
    (h) => [h, SPIKE.preflight.headers[h]],
  ),
);
// Dolos answers a submission with the transaction hash as plain text.
export const SUBMIT_HEADERS = {
  ...Object.fromEntries(
    ['access-control-allow-origin', 'access-control-expose-headers', 'vary'].map((h) => [
      h,
      SPIKE['tx-submit'].headers[h],
    ]),
  ),
  'content-type': SPIKE['tx-submit'].headers['content-type'],
};
const json = (status, body) => ({
  status,
  headers: { ...COMMON, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const empty = (status) => ({ status, headers: COMMON, body: '' });
// Recorded error answers, by what Dolos was asked.
export const ANSWERS = {
  routeMissing: () => empty(SPIKE['accounts-transactions'].status),
  unknownTransaction: () => empty(SPIKE['unknown-tx'].status),
  unknownComponent: () => json(SPIKE['vkh-unknown'].status, SPIKE['vkh-unknown'].body),
  scanLimit: () => json(SPIKE['scan-over-limit'].status, SPIKE['scan-over-limit'].body),
  countOver100: () => json(SPIKE['count-over-100'].status, SPIKE['count-over-100'].body),
  blockNotProduced: () => json(SPIKE['unknown-block'].status, SPIKE['unknown-block'].body),
  json,
};
const paymentOf = (address) => hex(decodeBech32(address).bytes.slice(1, 29));
// `txs`: { txHash, cbor, blockHeight, blockTime, txIndex?, inputs: [bech32], outputs?: [bech32], label?, metadata,
// json? }. A transaction is listed under every address among its inputs and outputs (and the account of each),
// and under the addr_vkh of every payment credential among them. `fault(path)` may return an answer that replaces
// the normal one. `maxScan` is the node's max_scan_items (Dolos default 3000). Every request path is recorded in
// `calls`.
export function blockfrostIndexer({ txs = [], maxScan = 3000, tip, fault = () => undefined, extraRows = {} } = {}) {
  const calls = [];
  // Transactions that appear only as list rows: plain transactions without metadata.
  const plain = new Set(Object.values(extraRows).flatMap((rows) => rows.map((r) => r.tx_hash)));
  const addressesOf = (t) => [...new Set([...t.inputs, ...(t.outputs ?? [])])];
  // The tip follows the transactions, which a caller may add later: every one has its 15 confirmations.
  const height = () => tip ?? Math.max(0, ...txs.map((t) => t.blockHeight + CONFIRMATIONS - 1));
  const row = (t) => ({
    tx_hash: t.txHash,
    tx_index: t.txIndex ?? 0,
    block_height: t.blockHeight,
    block_time: t.blockTime,
  });
  const ordered = () => [...txs].sort((a, b) => a.blockHeight - b.blockHeight || (a.txIndex ?? 0) - (b.txIndex ?? 0));
  const blockTime = (n) => {
    const confirming = txs.find((t) => t.blockHeight + CONFIRMATIONS - 1 === n);
    if (confirming) return confirming.blockTime + 300;
    const at = txs.find((t) => t.blockHeight === n);
    return at ? at.blockTime : 1_655_683_200 + n;
  };
  const block = (n) => ({
    ...SPIKE['blocks-latest'].body,
    height: n,
    time: blockTime(n),
    slot: n,
    hash: hex(new Uint8Array(32).fill(n % 256)),
  });
  // A list page as Dolos pages it: count 1..100, page ≥ 1, page × count ≤ max_scan_items, past the end [].
  const paged = (items, query) => {
    const count = Number(query.get('count') ?? 100);
    const page = Number(query.get('page') ?? 1);
    if (count > 100) return ANSWERS.countOver100();
    if (page * count > maxScan) return ANSWERS.scanLimit();
    return json(200, items.slice((page - 1) * count, page * count));
  };
  function answer(method, url) {
    const { pathname, searchParams } = new URL(url);
    const path = `${pathname}${new URL(url).search}`;
    calls.push(path);
    const faulted = fault(path);
    if (faulted) return faulted;
    const parts = pathname.split('/').filter(Boolean);
    // CORS preflight (Evolution's provider sends Content-Type on GET): Dolos answers 200 allowing everything.
    if (method === 'OPTIONS') return { status: SPIKE.preflight.status, headers: PREFLIGHT, body: '' };
    if (method === 'POST' && pathname === '/tx/submit') return undefined;
    if (method !== 'GET') return ANSWERS.routeMissing();
    if (parts[0] === 'accounts' && parts[2] === 'addresses' && parts.length === 3) {
      const listed = [
        ...new Set([
          ...ordered()
            .flatMap(addressesOf)
            .filter((a) => {
              try {
                return identityOf(a).key === parts[1];
              } catch {
                return false;
              }
            }),
          ...Object.keys(extraRows).filter((a) => a.startsWith('addr_test1') && identityOf(a).key === parts[1]),
        ]),
      ];
      return listed.length
        ? paged(
            listed.map((address) => ({ address })),
            searchParams,
          )
        : ANSWERS.unknownComponent();
    }
    if (parts[0] === 'addresses' && parts[2] === 'transactions' && parts.length === 3) {
      const target = parts[1];
      const matches = target.startsWith('addr_vkh')
        ? (t) => addressesOf(t).some((a) => paymentOf(a) === hex(decodeBech32(target).bytes))
        : (t) => addressesOf(t).includes(target);
      const rows = [...ordered().filter(matches).map(row), ...(extraRows[target] ?? [])].sort(
        (a, b) => a.block_height - b.block_height || a.tx_index - b.tx_index,
      );
      return rows.length ? paged(rows, searchParams) : ANSWERS.unknownComponent();
    }
    if (parts[0] === 'txs') {
      const t = txs.find((x) => x.txHash === parts[1]);
      const what = parts[2];
      if (!t && plain.has(parts[1]) && what === 'metadata' && parts.length === 3) return json(200, []);
      if (!t) return ANSWERS.unknownTransaction();
      if (parts.length === 2)
        return json(200, {
          ...SPIKE['tx-info'].body,
          hash: t.txHash,
          block_height: t.blockHeight,
          block_time: t.blockTime,
          slot: t.blockHeight,
          index: t.txIndex ?? 0,
        });
      if (what === 'cbor' && parts.length === 3) return json(200, { cbor: t.cbor });
      if (what === 'metadata' && parts.length === 3)
        return json(200, t.metadata ? [{ label: String(t.label), json_metadata: t.json ?? t.metadata }] : []);
      if (what === 'utxos' && parts.length === 3) {
        const [input] = SPIKE['tx-utxos'].body.inputs;
        const [output] = SPIKE['tx-utxos'].body.outputs;
        return json(200, {
          hash: t.txHash,
          inputs: t.inputs.map((address, i) => ({ ...input, address, tx_hash: '00'.repeat(32), output_index: i })),
          outputs: (t.outputs ?? t.inputs).map((address, i) => ({ ...output, address, output_index: i })),
        });
      }
      return ANSWERS.routeMissing();
    }
    if (parts[0] === 'blocks' && parts.length === 2) {
      if (parts[1] === 'latest') return json(200, block(height()));
      const n = Number(parts[1]);
      if (!Number.isSafeInteger(n) || n > height()) return ANSWERS.blockNotProduced();
      return n < 1 ? ANSWERS.unknownComponent() : json(200, block(n));
    }
    if (pathname === '/epochs/latest/parameters') return json(200, ADAPTER['epochs-latest-parameters'].body);
    return ANSWERS.routeMissing();
  }
  const fetch = async (url) => {
    const a = answer('GET', url);
    return new Response(a.body === '' ? null : a.body, { status: a.status, headers: a.headers });
  };
  return { calls, answer, fetch };
}
// Rows for an address that holds only plain transactions, as /addresses/{a}/transactions lists them.
export function fillerRows(count, { from = 1, height = 1 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    tx_hash: (from + i).toString(16).padStart(64, '0'),
    tx_index: 0,
    block_height: height + i,
    block_time: 1_655_683_200 + height + i,
  }));
}
export { encodeBech32 };
