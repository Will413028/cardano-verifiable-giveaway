// A Blockfrost-shaped indexer over a fixed set of transactions, answering the way Dolos 1.6.1 MiniBF answered on the
// dev chain. Status codes, error bodies and headers are copied from the recorded responses
// (docs/plans/2026-10-18-hardening-and-backend/dolos-1.6.1-*captures.json), not written here: a route the node lacks
// is 404 with an empty body, an unknown account 404 JSON, an unknown transaction 404 empty, a page past the end 200 [],
// count over 100 and page × count over max_scan_items 400, a block not produced yet 400. Shared by the Node tests
// (`fetch`) and the browser check (`answer`, for Playwright's route.fulfill).
import { readFileSync } from 'node:fs';
import {
  CONFIRMATIONS,
  decodeBech32,
  encodeBech32,
  hex,
  transactionParts,
  withdrawals,
} from '@giveaway/verifier-cli/library';

const recorded = (name) =>
  JSON.parse(readFileSync(new URL(`../docs/plans/2026-10-18-hardening-and-backend/${name}`, import.meta.url), 'utf8'));
const SPIKE = recorded('dolos-1.6.1-captures.json');
const ADAPTER = recorded('dolos-1.6.1-adapter-captures.json');
// Step 9b spike: /accounts/{stake} and /accounts/{stake}/withdrawals as Dolos 1.6.1 answered them (captures listed in
// request order; picked by path and state, see spike-withdrawal.md (1)).
const WITHDRAWAL = recorded('dolos-1.6.1-withdrawal-captures.json');
const captured = (test) => {
  const found = WITHDRAWAL.find(test);
  if (!found) throw new Error('withdrawal capture missing');
  return found;
};
const ORGANIZER_ACCOUNT = /^\/accounts\/stake_test1[a-z0-9]+$/;
// Registered and delegated to always-abstain, after the registration transaction; registered false, drep_id null
// before it; the 404 of a stake credential that never appeared in any output; one row of the withdrawal list.
export const ACCOUNT = {
  delegated: captured((c) => ORGANIZER_ACCOUNT.test(c.path) && c.body?.registered === true).body,
  unregistered: captured((c) => ORGANIZER_ACCOUNT.test(c.path) && c.body?.registered === false).body,
};
const UNKNOWN_ACCOUNT = captured((c) => c.path.endsWith('/withdrawals') && c.status === 404);
const WITHDRAWAL_ROW = captured((c) => c.path.endsWith('/withdrawals') && c.status === 200 && c.body.length).body[0];
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
// The project indexer sits behind the reverse proxy (deploy/dolos-proxy/nginx.conf, PD8 A), which refuses
// /tx/submit: the wallet submits (CIP-30 submitTx, BR-15). Answer recorded from nginx by tools/devchain/rproxy-check.mjs.
const PROXY = recorded('rproxy-nginx-1.30.6-report.json').variants.committed.captures;
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
  unknownAccount: () => json(UNKNOWN_ACCOUNT.status, UNKNOWN_ACCOUNT.body),
  scanLimit: () => json(SPIKE['scan-over-limit'].status, SPIKE['scan-over-limit'].body),
  countOver100: () => json(SPIKE['count-over-100'].status, SPIKE['count-over-100'].body),
  blockNotProduced: () => json(SPIKE['unknown-block'].status, SPIKE['unknown-block'].body),
  json,
};
// The stake address (bech32) of a base address, or null for any other address.
const stakeOf = (address) => {
  const bytes = decodeBech32(address).bytes;
  return bytes[0] >> 4 === 0 && bytes.length === 57
    ? encodeBech32('stake_test', Uint8Array.from([0xe0, ...bytes.slice(29)]))
    : null;
};
// The stake addresses a transaction withdraws from, read from its CBOR (body field 5), as Dolos indexes them
// (indexes/delta.rs, whatever the amount; spike-withdrawal.md). `listedUnder` replaces this for an indexer that lists a
// transaction under accounts its bytes do not withdraw from.
const withdrawnBy = (t) =>
  t.listedUnder ??
  [...withdrawals(transactionParts(t.cbor).body).keys()].map((account) =>
    encodeBech32('stake_test', hexBytes(account)),
  );
const hexBytes = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
// `txs`: { txHash, cbor, blockHeight, blockTime, txIndex?, inputs: [bech32], outputs?: [bech32], label?, metadata,
// json?, listedUnder? }. A transaction is listed under /accounts/{stake}/withdrawals of every stake address it
// withdraws from. A stake address is known to the node (its account answers, its withdrawal list is 200 even when
// empty) once it appears in an input or output address, in `accounts` or in `extraWithdrawals`; otherwise both answer
// the recorded 404. `accounts` maps a stake address to the fields replacing the recorded registered-and-delegated
// account. `extraWithdrawals` maps a stake address to rows of plain transactions (no metadata) merged into its list.
// `fault(path)` may return an answer that replaces the normal one. `maxScan` is the node's max_scan_items (Dolos default
// 3000). Every request path is recorded in `calls`.
export function blockfrostIndexer({
  txs = [],
  maxScan = 3000,
  tip,
  fault = () => undefined,
  accounts = {},
  extraWithdrawals = {},
} = {}) {
  const calls = [];
  // Transactions that appear only as list rows: plain transactions without metadata.
  const plain = new Set(Object.values(extraWithdrawals).flatMap((rows) => rows.map((r) => r.tx_hash)));
  const addressesOf = (t) => [...new Set([...t.inputs, ...(t.outputs ?? [])])];
  const known = (stake) =>
    stake in accounts ||
    stake in extraWithdrawals ||
    txs.some((t) => addressesOf(t).some((a) => stakeOf(a) === stake) || withdrawnBy(t).includes(stake));
  // The tip follows the transactions, which a caller may add later: every one has its 15 confirmations.
  const height = () => tip ?? Math.max(0, ...txs.map((t) => t.blockHeight + CONFIRMATIONS - 1));
  // A row of the withdrawal list: the recorded row's fields, this transaction's values. No tx_index (Dolos has none).
  const withdrawalRow = (t) => ({
    ...WITHDRAWAL_ROW,
    tx_hash: t.txHash,
    amount: '0',
    tx_slot: t.blockHeight,
    block_time: t.blockTime,
    block_height: t.blockHeight,
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
    if (method === 'POST' && pathname === '/tx/submit') return PROXY['tx-submit'];
    if (method !== 'GET') return ANSWERS.routeMissing();
    if (parts[0] === 'accounts' && parts.length === 2) {
      if (!known(parts[1])) return ANSWERS.unknownAccount();
      return json(200, { ...ACCOUNT.delegated, stake_address: parts[1], ...accounts[parts[1]] });
    }
    if (parts[0] === 'accounts' && parts[2] === 'withdrawals' && parts.length === 3) {
      if (!known(parts[1])) return ANSWERS.unknownAccount();
      // Ascending: block height, then position in the block (Dolos's order for asc and for no order at all).
      const rows = [
        ...ordered()
          .filter((t) => withdrawnBy(t).includes(parts[1]))
          .map((t) => ({ row: withdrawalRow(t), index: t.txIndex ?? 0 })),
        ...(extraWithdrawals[parts[1]] ?? []).map((row) => ({ row, index: 0 })),
      ]
        .sort((a, b) => a.row.block_height - b.row.block_height || a.index - b.index)
        .map((x) => x.row);
      return paged(searchParams.get('order') === 'desc' ? rows.reverse() : rows, searchParams);
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
// Withdrawal-list rows of plain transactions (0 ADA withdrawals without the protocol label), one per block, the
// recorded row's fields with these values. `time` is the first row's block time.
export function fillerRows(count, { from = 1, height = 1, time = 1_655_683_200 + height } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    ...WITHDRAWAL_ROW,
    tx_hash: (from + i).toString(16).padStart(64, '0'),
    amount: '0',
    tx_slot: height + i,
    block_time: time + i,
    block_height: height + i,
  }));
}
export { encodeBech32 };
