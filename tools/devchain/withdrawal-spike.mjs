// Plan step 9b spike item (1): how Dolos 1.6.1 (emulator dev chain, tools/devchain/dolos.toml) indexes reward
// withdrawals in /accounts/{stake}/withdrawals. Indexing behaviour only: the emulator mempool does not run the
// ledger's withdrawal, certificate or DRep rules, so nothing here says what a real ledger accepts (that is
// withdrawal-yaci.mjs). Test keys only.
// Usage, with a fresh Dolos on DEVCHAIN_URL (default 3010):
//   DEVCHAIN_URL=http://127.0.0.1:3030 node tools/devchain/withdrawal-spike.mjs <captures.json> > report.json
// Results: docs/plans/2026-10-18-hardening-and-backend/spike-withdrawal.md.
import { writeFileSync } from 'node:fs';
import { encodeBech32, LABEL } from '@giveaway/verifier-cli/library';
import { testKey, unhex } from '../../tests/cardano.mjs';
import { BASE, fanOut, GENESIS, stakeAddress, utxos, waitFor, WALLETS } from './devchain.mjs';
import { balanced, regCert, voteDelegAbstain } from './withdrawal-tx.mjs';

const log = (...args) => console.error(new Date().toISOString(), ...args);
const captures = [];
async function get(path) {
  const response = await fetch(`${BASE}${path}`);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  const result = { status: response.status, headers: Object.fromEntries(response.headers), body };
  captures.push({ path, ...result });
  return result;
}
async function submit(label, tx) {
  const response = await fetch(`${BASE}/tx/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/cbor' },
    body: unhex(tx.cbor),
  });
  const result = { label, txHash: tx.txHash, status: response.status, body: await response.text() };
  captures.push({ path: `POST /tx/submit (${label})`, ...result });
  log('submit', label, result.status, result.body.slice(0, 200));
  return result;
}
async function included(txHash, timeoutMs = 20_000) {
  try {
    const tx = await waitFor(txHash, { timeoutMs });
    return { included: true, block_height: tx.block_height, index: tx.index };
  } catch {
    return { included: false };
  }
}

const report = { dolos: BASE, steps: {} };
const params = (await get('/epochs/latest/parameters')).body;
const fees = { a: BigInt(params.min_fee_a), b: BigInt(params.min_fee_b) };
const deposit = BigInt(params.key_deposit);
report.params = { min_fee_a: params.min_fee_a, min_fee_b: params.min_fee_b, key_deposit: params.key_deposit };

const STAKE = testKey(2); // organizer stake (WALLETS.organizer = payment 1 + stake 2)
const stake = stakeAddress(STAKE.hash);
const OTHER_STAKE = testKey(5); // WALLETS.other = payment 4 + stake 5
const NEVER = testKey(9); // never appears on the dev chain
const NEVER_WITHDRAWN = testKey(10); // used only by the last step
const thirdParty = { hex: `60${testKey(3).hash}`, keys: [testKey(3)] };
thirdParty.address = encodeBech32('addr_test', unhex(thirdParty.hex));

// 1. Before the stake credential appears in any output.
report.steps.beforeAnyOutput = await get(`/accounts/${stake}/withdrawals`);
report.steps.unknownStake = await get(`/accounts/${stakeAddress(NEVER.hash)}/withdrawals`);
report.steps.malformedStake = await get(`/accounts/stake_test1notbech32/withdrawals`);

// 2. Fund the organizer and the other wallet at their base addresses, the third party at an enterprise address.
await fanOut(GENESIS[1], 40, 50_000_000n, WALLETS.organizer);
await fanOut(GENESIS[4], 5, 50_000_000n, WALLETS.other);
await fanOut(GENESIS[3], 5, 50_000_000n, thirdParty);
report.steps.afterFunding = {
  account: await get(`/accounts/${stake}`),
  withdrawals: await get(`/accounts/${stake}/withdrawals`),
};

const pool = await utxos(WALLETS.organizer.address);
const take = () => pool.shift();
const send = async (label, spec, extra = {}) => {
  const tx = balanced(spec, { ...fees, ...extra });
  const result = await submit(label, tx);
  return { ...result, fee: tx.fee.toString(), ...(result.status === 200 ? await included(tx.txHash) : {}) };
};
const [payment1, stake2] = WALLETS.organizer.keys;

// 3. Withdrawal for a stake credential that is not registered (seen in outputs only).
{
  const [input] = await utxos(WALLETS.other.address);
  report.steps.unregisteredZeroWithdrawal = await send('other stake 5, not registered, 0 ADA', {
    inputs: [input],
    change: WALLETS.other.hex,
    withdrawals: [[OTHER_STAKE.hash, 0n]],
    witnesses: WALLETS.other.keys,
  });
}
// 4. Register the organizer stake and delegate its vote to always-abstain. First balanced as the ledger requires
// (deposit counted), then balanced as pallas-validate 1.3.0 checks value (deposit not counted), so that Dolos indexes
// a registration at all.
const registration = {
  inputs: [take()],
  change: WALLETS.organizer.hex,
  certs: [regCert(STAKE.hash, deposit), voteDelegAbstain(STAKE.hash)],
  witnesses: [payment1, stake2],
};
report.steps.registerAndVoteDeleg = await send('register stake 2 + vote deleg abstain (ledger balance)', registration, {
  deposits: deposit,
});
report.steps.registerAndVoteDelegPallasBalance = await send(
  'register stake 2 + vote deleg abstain (pallas balance)',
  registration,
  { pallasRule: true },
);
report.steps.accountAfterRegistration = await get(`/accounts/${stake}`);
// 5. A commitment-shaped transaction with a 0 ADA withdrawal: 2 ADA to self, change, label metadata, the stake key
// as the only required signer, a validity upper bound, the withdrawal.
const tip = (await get('/blocks/latest')).body;
const commitmentSpec = (input, drawId) => ({
  inputs: [input],
  outputs: [[WALLETS.organizer.hex, 2_000_000n]],
  change: WALLETS.organizer.hex,
  metadata: { protocol: 'spike-9b', drawId },
  label: LABEL,
  signers: [STAKE.hash],
  invalidHereafter: tip.slot + 100_000,
  withdrawals: [[STAKE.hash, 0n]],
  witnesses: [payment1, stake2],
});
report.steps.commitmentZeroWithdrawal = await send('commitment-shaped, 0 ADA withdrawal', commitmentSpec(take(), 'w0'));
report.steps.txWithdrawals = await get(`/txs/${report.steps.commitmentZeroWithdrawal.txHash}/withdrawals`);
// 6. A non-zero withdrawal. The dev chain pays no rewards, so the reward balance is 0 and a real ledger refuses any
// non-zero amount. Submitted balanced as the ledger requires (withdrawal counted as consumed), then balanced as
// pallas-validate checks value (withdrawal not counted): only the second can reach a block and show how Dolos lists
// a non-zero amount.
const nonZero = () => ({
  inputs: [take()],
  change: WALLETS.organizer.hex,
  withdrawals: [[STAKE.hash, 1_000_000n]],
  witnesses: [payment1, stake2],
});
report.steps.nonZeroWithdrawal = await send('stake 2, 1 ADA withdrawal (ledger balance)', nonZero());
report.steps.nonZeroWithdrawalPallasBalance = await send('stake 2, 1 ADA withdrawal (pallas balance)', nonZero(), {
  pallasRule: true,
});
// 7. A third party's withdrawal for the organizer stake without the stake key witness.
{
  const [input] = await utxos(thirdParty.address);
  report.steps.thirdPartyWithoutWitness = await send('third party, organizer stake, no stake witness', {
    inputs: [input],
    change: thirdParty.hex,
    withdrawals: [[STAKE.hash, 0n]],
    witnesses: thirdParty.keys,
  });
}
report.steps.afterSingles = {
  account: await get(`/accounts/${stake}`),
  withdrawals: await get(`/accounts/${stake}/withdrawals`),
};

// 8. Many rows: 30 more 0 ADA withdrawals, submitted together so several share a block.
const batch = [];
for (let i = 0; i < 30; i++) {
  const tx = balanced(commitmentSpec(take(), `batch-${i}`), fees);
  batch.push({ ...(await submit(`batch ${i}`, tx)) });
}
for (const b of batch) Object.assign(b, await included(b.txHash, 60_000));
report.steps.batch = {
  submitted: batch.length,
  accepted: batch.filter((b) => b.status === 200).length,
  included: batch.filter((b) => b.included).length,
};
const expected = [
  report.steps.commitmentZeroWithdrawal,
  report.steps.nonZeroWithdrawal,
  report.steps.nonZeroWithdrawalPallasBalance,
  report.steps.thirdPartyWithoutWitness,
  ...batch,
].filter((x) => x.included);
report.steps.expectedRows = expected.map((x) => ({ txHash: x.txHash, block_height: x.block_height, index: x.index }));

async function all(query, count) {
  const rows = [];
  let requests = 0;
  for (let page = 1; ; page++) {
    const r = await get(`/accounts/${stake}/withdrawals?${query}count=${count}&page=${page}`);
    requests++;
    if (r.status !== 200) return { rows, requests, error: { status: r.status, body: r.body } };
    rows.push(...r.body);
    if (r.body.length < count) return { rows, requests };
  }
}
const ids = (rows) => rows.map((r) => r.tx_hash);
const asc100a = await all('order=asc&', 100);
const asc100b = await all('order=asc&', 100);
const asc10 = await all('order=asc&', 10);
const desc10 = await all('order=desc&', 10);
const noOrder = await all('', 100);
const heights = (rows) => rows.map((r) => r.block_height);
const sortedAsc = (rows) => heights(rows).every((h, i, a) => i === 0 || a[i - 1] <= h);
report.listing = {
  firstRow: asc100a.rows[0],
  rows: asc100a.rows.length,
  requests: { asc100: asc100a.requests, asc10: asc10.requests, desc10: desc10.requests },
  sameOrderRepeatedAsc100: JSON.stringify(ids(asc100a.rows)) === JSON.stringify(ids(asc100b.rows)),
  sameOrderAsc10VsAsc100: JSON.stringify(ids(asc10.rows)) === JSON.stringify(ids(asc100a.rows)),
  descIsReverseOfAsc: JSON.stringify(ids(desc10.rows)) === JSON.stringify(ids(asc100a.rows).reverse()),
  defaultOrderIsAsc: JSON.stringify(ids(noOrder.rows)) === JSON.stringify(ids(asc100a.rows)),
  ascHeightsNonDecreasing: sortedAsc(asc100a.rows),
  duplicates: asc100a.rows.length - new Set(ids(asc100a.rows)).size,
  missingExpected: expected.filter((x) => !ids(asc100a.rows).includes(x.txHash)).map((x) => x.txHash),
  unexpected: ids(asc100a.rows).filter((h) => !expected.some((x) => x.txHash === h)),
  // Rows sharing a block: does asc follow the transaction's position in the block?
  sameBlockOrder: (() => {
    const index = new Map(expected.map((x) => [x.txHash, x.index]));
    const groups = new Map();
    for (const r of asc100a.rows)
      groups.set(r.block_height, [...(groups.get(r.block_height) ?? []), index.get(r.tx_hash)]);
    const multi = [...groups.values()].filter((g) => g.length > 1);
    return {
      blocksWithSeveralRows: multi.length,
      allFollowTxIndex: multi.every((g) => g.every((v, i) => i === 0 || g[i - 1] < v)),
    };
  })(),
  amounts: [...new Set(asc100a.rows.map((r) => r.amount))],
  fields: Object.keys(asc100a.rows[0] ?? {}),
};
// from/to (absent from the Blockfrost spec for this endpoint; Dolos's Pagination parses them for every route).
const mid = asc100a.rows[Math.floor(asc100a.rows.length / 2)];
const fromTo = async (q) => {
  const r = await get(`/accounts/${stake}/withdrawals?order=asc&count=100&${q}`);
  return {
    query: q,
    status: r.status,
    rows: Array.isArray(r.body) ? r.body.length : null,
    body: Array.isArray(r.body) ? undefined : r.body,
    minHeight: Array.isArray(r.body) ? Math.min(...heights(r.body)) : null,
    maxHeight: Array.isArray(r.body) ? Math.max(...heights(r.body)) : null,
  };
};
report.fromTo = [
  await fromTo(`from=${mid.block_height}`),
  await fromTo(`to=${mid.block_height}`),
  await fromTo(`from=${mid.block_height}&to=${mid.block_height}`),
  await fromTo(`from=${mid.block_height}:1`),
  await fromTo(`from=${mid.block_height + 1}&to=${mid.block_height}`),
  await fromTo(`from=abc`),
];
report.limits = {
  count101: await get(`/accounts/${stake}/withdrawals?count=101`),
  pagePastEnd: await get(`/accounts/${stake}/withdrawals?count=100&page=50`),
  orderBad: await get(`/accounts/${stake}/withdrawals?order=up`),
};
report.otherStakeWithdrawals = await get(`/accounts/${stakeAddress(OTHER_STAKE.hash)}/withdrawals`);
report.thirdPartyIsVisibleAs = 'row in organizer stake withdrawals if thirdPartyWithoutWitness.included';

// 9. Last, because it may stop the node: a withdrawal for a stake credential Dolos has never seen
// (model/accounts.rs WithdrawalInc::apply expects an existing account).
{
  const tx = balanced(
    {
      inputs: [take()],
      change: WALLETS.organizer.hex,
      withdrawals: [[NEVER_WITHDRAWN.hash, 0n]],
      witnesses: [payment1, NEVER_WITHDRAWN],
    },
    fees,
  );
  const result = await submit('never-seen stake 10, 0 ADA', tx);
  report.steps.neverSeenStake = { ...result, ...(result.status === 200 ? await included(tx.txHash, 15_000) : {}) };
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  try {
    report.steps.neverSeenStake.healthAfter = (await get('/health')).body;
    report.steps.neverSeenStake.withdrawals = await get(`/accounts/${stakeAddress(NEVER_WITHDRAWN.hash)}/withdrawals`);
  } catch (error) {
    report.steps.neverSeenStake.healthAfter = `request failed: ${error.cause?.code ?? error.message}`;
  }
}

writeFileSync(process.argv[2] ?? 'captures.json', `${JSON.stringify(captures, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
