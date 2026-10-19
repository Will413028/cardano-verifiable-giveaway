// Plan step 8b acceptance, rewritten for step 9b (PD10: commitments withdraw from the organizer reward account, the
// history is /accounts/{stake}/withdrawals), on a fresh dev chain (tools/devchain/dolos.toml), test keys only. Usage,
// with Dolos running and `make build` done:
//   node tools/devchain/acceptance.mjs <out dir>
// Writes into <out dir>: report.json (printed too), captures.json (MiniBF answers the adapter and the page rely on)
// and the proofs the CLI verified; exits 1 when an expectation listed at the end fails. Covers: stake registration and
// DRep delegation before the first commitment, two read-only reads of the identity's withdrawal list (set, order,
// count = sent), the requests of one full verification, a flood of at least 3,000 outputs to "attacker payment +
// organizer stake" addresses (PD10) after which uniqueness still passes with the same requests, CLI --indexer PASS and
// tampered FAIL, CLI without --indexer, an overlapping commitment from the identity's second address (FAIL, listed),
// an enterprise organizer (FAIL with the reason) and a second, independent identity whose commitment passes.
// The emulator mempool checks no withdrawal witness, registration or DRep rule (spike-withdrawal.md): what a real
// ledger refuses is evidenced there, not here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import {
  ALGORITHM,
  BlockfrostChain,
  commitmentValidUntil,
  encodeBech32,
  FIXTURE,
  identityOf,
  preprodSlotAt,
  QUICKNET,
  selectWinners,
  VERSION,
  verifyProof,
} from '@giveaway/verifier-cli/library';
import { hex, unhex } from '../../tests/cardano.mjs';
import { BASE, build, commitment, fanOut, GENESIS, get, submit, utxos, waitFor, WALLETS } from './devchain.mjs';
import { balanced, regCert, voteDelegAbstain } from './withdrawal-tx.mjs';

const out = process.argv[2];
if (!out) throw new Error('Usage: node tools/devchain/acceptance.mjs <out dir>');
await mkdir(out, { recursive: true });
const root = fileURLToPath(new URL('../../', import.meta.url));
const log = (...args) => console.error(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { base: BASE, version: (await get('/')).body };
const captures = {};
const capture = async (name, path) => {
  const response = await get(path);
  delete response.headers.date;
  captures[name] = { path, method: 'GET', ...response };
  return response;
};
const bundle = (drawId) => ({
  version: VERSION,
  algorithm: ALGORITHM,
  drawId,
  entrants: ['alice', 'bob', 'carol', 'dana'],
  rules: { winners: 2 },
  drand: { chainHash: QUICKNET, round: FIXTURE.round },
});
const params = (await get('/epochs/latest/parameters')).body;
const fees = { a: BigInt(params.min_fee_a), b: BigInt(params.min_fee_b) };
const rewardAccount = (wallet) => `e0${wallet.keys[1].hash}`;
const stakeOf = (wallet) => identityOf(wallet.address).key;
// Every transaction this script sends that withdraws from the organizer reward account (stake key 2), in order.
const sent = new Set();
const send = async (tx) => {
  const r = await submit(tx.cbor);
  if (r.status !== 200) throw new Error(`submit rejected: ${r.status} ${r.body}`);
  return tx.txHash;
};
const waitHeight = async (height) => {
  while ((await get('/blocks/latest')).body.height < height) await sleep(1000);
};

// 1. Funding: the organizer's base address gets 3 fan-outs of 100 UTxOs; its second address, the other identity and
// the never-registered wallet a few each.
log('funding');
for (let i = 0; i < 3; i++) await fanOut(GENESIS[1], 100, 50_000_000n, WALLETS.organizer);
await fanOut(GENESIS[6], 5, 50_000_000n, WALLETS.organizerSecond);
await fanOut(GENESIS[4], 5, 50_000_000n, WALLETS.other);
await fanOut(GENESIS[4], 2, 50_000_000n, WALLETS.unregistered);
const pool = (await utxos(WALLETS.organizer.address)).filter((u) => u.lovelace === 50_000_000n);

// 2. Stake registration and DRep delegation (always-abstain), a transaction of its own before the first commitment
// (spike-withdrawal.md: the ledger refuses both in the commitment). Balanced the way the emulator mempool checks value
// (pallas-validate: deposits not counted); a real ledger takes the 2 ADA deposit.
log('registration');
async function register(wallet, input) {
  const stake = wallet.keys[1];
  const tx = balanced(
    {
      inputs: [input],
      change: wallet.hex,
      certs: [regCert(stake.hash, params.key_deposit), voteDelegAbstain(stake.hash)],
      witnesses: wallet.keys,
    },
    { ...fees, pallasRule: true },
  );
  await send(tx);
  await waitFor(tx.txHash);
  return { txHash: tx.txHash, account: (await get(`/accounts/${stakeOf(wallet)}`)).body };
}
report.registration = {
  organizer: await register(WALLETS.organizer, pool.pop()),
  other: await register(WALLETS.other, (await utxos(WALLETS.other.address))[0]),
};

// 3. History: plain self-transfers of the organizer, each with its 0 ADA withdrawal (as every wallet transaction that
// touches the reward account would be listed), submitted 30 at a time so blocks (at most 10 transactions) hold several.
log('history');
const HISTORY = Number(process.env.ACCEPTANCE_TXS ?? 260);
const withdrawal = (wallet) => [[rewardAccount(wallet), 0n]];
for (let start = 0; start < HISTORY; start += 30) {
  const batch = [];
  for (let i = start; i < Math.min(HISTORY, start + 30); i++)
    batch.push(
      await build({
        from: WALLETS.organizer,
        inputs: [pool[i]],
        outputs: [[WALLETS.organizer.hex, 2_000_000n]],
        withdrawals: withdrawal(WALLETS.organizer),
      }),
    );
  for (const tx of batch) sent.add(await send(tx));
  await Promise.all(batch.map((tx) => waitFor(tx.txHash)));
}

// 4. The commitment under test, built as the page builds it: the stake key as the only required signer,
// invalid_hereafter at commitmentValidUntil(round) on the pinned preprod clock, a 0 ADA withdrawal from its account.
async function commit(wallet, drawId, input, { withdraw = true } = {}) {
  const b = bundle(drawId);
  const tx = await build({
    from: wallet,
    inputs: [input],
    outputs: [[wallet.hex, 2_000_000n]],
    metadata: await commitment(b),
    signers: [wallet.keys.at(-1).hash],
    invalidHereafter: preprodSlotAt(commitmentValidUntil(b.drand.round)),
    withdrawals: withdraw ? withdrawal(wallet) : [],
  });
  await send(tx);
  const included = await waitFor(tx.txHash);
  const proof = {
    format: 'giveaway-proof-2',
    network: 'preprod',
    bundle: b,
    txHash: tx.txHash,
    owner: wallet.address,
    beacon: FIXTURE,
    winners: await selectWinners(b, FIXTURE.randomness),
  };
  return { tx, proof, included };
}
log('commitment');
const target = await commit(WALLETS.organizer, 'devchain-target', pool[HISTORY]);
sent.add(target.tx.txHash);
// 15 confirmations: the emulator produces one block per second.
await waitHeight(target.included.block_height + 14);

// 5. Read-only reads of the organizer's withdrawal list, twice with no transaction in between, against what was sent.
async function withdrawalList(wallet) {
  const rows = [];
  let requests = 0;
  for (let page = 1; ; page++) {
    const r = await get(`/accounts/${stakeOf(wallet)}/withdrawals?order=asc&count=100&page=${page}`);
    requests++;
    if (r.status !== 200) throw new Error(`withdrawals ${r.status} ${JSON.stringify(r.body)}`);
    rows.push(...r.body);
    if (r.body.length < 100) return { rows, requests };
  }
}
log('enumeration');
{
  const first = await withdrawalList(WALLETS.organizer);
  await sleep(3000);
  const second = await withdrawalList(WALLETS.organizer);
  const listed = new Set(first.rows.map((r) => r.tx_hash));
  const order = (x) => x.rows.map((r) => `${r.block_height}:${r.tx_hash}`);
  report.enumeration = {
    tip: (await get('/blocks/latest')).body.height,
    rows: first.rows.length,
    pages: first.requests,
    fields: Object.keys(first.rows[0]).sort(),
    sent: sent.size,
    missingSent: [...sent].filter((h) => !listed.has(h)).length,
    notSent: [...listed].filter((h) => !sent.has(h)).length,
    sameSetAndOrder: JSON.stringify(order(first)) === JSON.stringify(order(second)),
    ascending: first.rows.every((r, i) => i === 0 || r.block_height >= first.rows[i - 1].block_height),
    blocksWithSeveral: [...Map.groupBy(first.rows, (r) => r.block_height).values()].filter((x) => x.length > 1).length,
  };
}

// 6. Requests of one full verification through the adapter, by endpoint.
async function countedVerification(proof) {
  const calls = [];
  const chain = new BlockfrostChain(BASE, (input, init) => {
    calls.push(new URL(input).pathname.replace(/[a-f0-9]{64}/, '{h}').replace(/addr_test1\w+|stake_test1\w+/, '{a}'));
    return fetch(input, init);
  });
  const started = performance.now();
  const verdict = await verifyProof(proof, { chain });
  // Recorded, never asserted: localhost duration only.
  const ms = Math.round(performance.now() - started);
  const byEndpoint = {};
  for (const c of calls) byEndpoint[c] = (byEndpoint[c] ?? 0) + 1;
  return {
    status: verdict.status,
    conflicts: verdict.conflicts.map((c) => c.txHash),
    failed: verdict.checks.filter((c) => c.result !== 'pass').map((c) => `${c.name}: ${c.detail}`),
    requests: calls.length,
    byEndpoint,
    ms,
  };
}
log('verification');
report.requests = { organizer: { n: report.enumeration.rows, ...(await countedVerification(target.proof)) } };

// 7. PD10 flood: a third party pays outputs to addresses that pair its own derived payment keys with the organizer's
// stake key (CIP-19 lets anyone build them), as many per transaction as max_tx_size allows, until at least 3,000 such
// outputs exist. Under the PD9 enumeration every one of them was a row of the organizer's history; the withdrawal list
// never sees them.
log('flood');
{
  const FLOOD = Number(process.env.ACCEPTANCE_FLOOD ?? 3000);
  const attacker = { hex: GENESIS[3].hex, keys: GENESIS[3].keys };
  const derived = (i) => {
    const secret = blake2b(new TextEncoder().encode(`pd10-attacker:${i}`), { dkLen: 32 });
    return hex(blake2b(ed25519.getPublicKey(secret), { dkLen: 28 }));
  };
  const mangled = (i) => `00${derived(i)}${WALLETS.organizer.keys[1].hash}`;
  const outputsFor = (k, offset) => Array.from({ length: k }, (_, i) => [mangled(offset + i), 1_000_000n]);
  let [input] = (await utxos(GENESIS[3].address)).sort((x, y) => (x.lovelace > y.lovelace ? -1 : 1));
  // Largest k whose signed transaction fits max_tx_size.
  let lo = 1;
  let hi = 400;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const tx = await build({ from: attacker, inputs: [input], outputs: outputsFor(mid, 0) });
    if (tx.cbor.length / 2 <= params.max_tx_size) lo = mid;
    else hi = mid - 1;
  }
  const accountAddresses = async () => {
    let count = 0;
    for (let page = 1; ; page++) {
      const r = await get(`/accounts/${stakeOf(WALLETS.organizer)}/addresses?count=100&page=${page}`);
      if (r.status !== 200) throw new Error(`accounts/addresses ${r.status}`);
      count += r.body.length;
      if (r.body.length < 100) return count;
    }
  };
  const addressesBefore = await accountAddresses();
  const transactions = [];
  for (let offset = 0; offset < FLOOD; offset += lo) {
    const tx = await build({ from: attacker, inputs: [input], outputs: outputsFor(lo, offset) });
    await send(tx);
    await waitFor(tx.txHash);
    transactions.push({ txHash: tx.txHash, bytes: tx.cbor.length / 2 });
    // The change output is the last one: spend it in the next transaction.
    const outs = (await get(`/txs/${tx.txHash}/utxos`)).body.outputs;
    input = { txHash: tx.txHash, index: lo, lovelace: BigInt(outs[lo].amount[0].quantity) };
  }
  await waitHeight((await get('/blocks/latest')).body.height + 1);
  const addressesAfter = await accountAddresses();
  const after = await withdrawalList(WALLETS.organizer);
  report.flood = {
    outputsPerTx: lo,
    transactions: transactions.length,
    outputs: lo * transactions.length,
    // Every new address holds exactly one transaction, so the PD9 enumeration would have read at least this many rows.
    accountAddressesBefore: addressesBefore,
    accountAddressesAfter: addressesAfter,
    withdrawalRowsBefore: report.enumeration.rows,
    withdrawalRowsAfter: after.rows.length,
    verification: await countedVerification(target.proof),
  };
}

// 8. CLI: --indexer at the dev chain PASS; tampered bundle FAIL; no --indexer refused.
const cli = (file, ...extra) =>
  spawnSync(process.execPath, [`${root}apps/verifier-cli/index.mjs`, file, ...extra], { encoding: 'utf8' });
const write = async (name, value) => {
  const file = `${out}/${name}`;
  await writeFile(file, JSON.stringify(value, null, 2));
  return file;
};
const verdictOf = (r) => (r.stdout ? JSON.parse(r.stdout) : null);
log('cli');
{
  const genuine = await write('proof.json', target.proof);
  const tamperedBundle = { ...target.proof.bundle, entrants: [...target.proof.bundle.entrants, 'mallory'] };
  const tampered = await write('proof-tampered.json', {
    ...target.proof,
    bundle: tamperedBundle,
    winners: await selectWinners(tamperedBundle, FIXTURE.randomness),
  });
  const pass = cli(genuine, '--indexer', BASE);
  const fail = cli(tampered, '--indexer', BASE);
  const none = cli(genuine);
  report.cli = {
    pass: {
      exit: pass.status,
      status: verdictOf(pass)?.status,
      checks: verdictOf(pass)?.checks.map((c) => `${c.name}: ${c.result}`),
    },
    tampered: {
      exit: fail.status,
      status: verdictOf(fail)?.status,
      failed: verdictOf(fail)
        ?.checks.filter((c) => c.result !== 'pass')
        .map((c) => `${c.name}: ${c.result}`),
    },
    withoutIndexer: { exit: none.status, stderr: none.stderr.trim() },
  };
}

// 9. The same identity commits again from its second payment address while the first is open: it withdraws from the
// same reward account, so the withdrawal list shows the conflict.
log('conflict');
{
  const [input] = await utxos(WALLETS.organizerSecond.address);
  const second = await commit(WALLETS.organizerSecond, 'devchain-overlap', input);
  await waitHeight(second.included.block_height + 14);
  const r = cli(await write('proof-after-overlap.json', target.proof), '--indexer', BASE);
  const v = verdictOf(r);
  report.overlap = {
    txHash: second.tx.txHash,
    exit: r.status,
    status: v?.status,
    conflicts: v?.conflicts.map((c) => c.txHash),
    unique: v?.checks.find((c) => c.name === 'Unique commitment'),
    requests: await countedVerification(target.proof),
  };
}

// 10. An enterprise organizer: it has no reward account to withdraw from, so its commitment (signed with its payment
// key, as before PD10) is refused with the reason, by the CLI and before any indexer request.
log('enterprise');
{
  const funding = await fanOut(WALLETS.enterprise, 2, 50_000_000n);
  const [input] = (await utxos(WALLETS.enterprise.address)).filter((u) => u.txHash === funding);
  const committed = await commit(WALLETS.enterprise, 'devchain-enterprise', input, { withdraw: false });
  await waitHeight(committed.included.block_height + 14);
  const r = cli(await write('proof-enterprise.json', committed.proof), '--indexer', BASE);
  report.enterprise = {
    txHash: committed.tx.txHash,
    exit: r.status,
    status: verdictOf(r)?.status,
    evidence: verdictOf(r)?.checks.find((c) => c.name === 'Cardano evidence'),
    requests: (await countedVerification(committed.proof)).requests,
  };
}

// 11. A second identity (payment 4, stake 5), registered above, commits once: the passing proof the live browser
// check reads (its metadata and CBOR through the project indexer).
log('other identity');
{
  const [input] = (await utxos(WALLETS.other.address)).filter((u) => u.lovelace === 50_000_000n);
  const committed = await commit(WALLETS.other, 'devchain-other', input);
  await waitHeight(committed.included.block_height + 14);
  const r = cli(await write('proof-other.json', committed.proof), '--indexer', BASE);
  report.other = {
    txHash: committed.tx.txHash,
    exit: r.status,
    status: verdictOf(r)?.status,
    requests: await countedVerification(committed.proof),
  };
}

// 12. MiniBF answers the adapter and the page rely on.
log('captures');
{
  const stake = stakeOf(WALLETS.organizer);
  await capture('account', `/accounts/${stake}`);
  await capture('account-unregistered', `/accounts/${stakeOf(WALLETS.unregistered)}`);
  await capture('account-unknown', `/accounts/${encodeBech32('stake_test', unhex(`e0${'ab'.repeat(28)}`))}`);
  await capture('withdrawals', `/accounts/${stake}/withdrawals?order=asc&count=100&page=1`);
  await capture('withdrawals-past-end', `/accounts/${stake}/withdrawals?order=asc&count=100&page=9`);
  await capture(
    'withdrawals-unregistered',
    `/accounts/${stakeOf(WALLETS.unregistered)}/withdrawals?order=asc&count=100&page=1`,
  );
  for (const p of ['', '/cbor', '/utxos', '/metadata', '/withdrawals'])
    await capture(`commitment${p.replace('/', '-') || '-info'}`, `/txs/${target.tx.txHash}${p}`);
  await capture('blocks-latest', '/blocks/latest');
  for (const c of Object.values(captures)) if (Array.isArray(c.body) && c.body.length > 3) c.body = c.body.slice(0, 3);
}
await writeFile(`${out}/captures.json`, `${JSON.stringify(captures, null, 2)}\n`);
await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

// Expectations (plan step 9b acceptance), checked after the report is written so a failure still leaves the evidence.
const r = report;
assert.equal(r.registration.organizer.account.registered, true);
assert.equal(r.registration.organizer.account.drep_id, 'drep_always_abstain');
assert.equal(r.enumeration.rows, HISTORY + 1);
assert.equal(r.enumeration.missingSent, 0);
assert.equal(r.enumeration.notSent, 0);
assert.ok(r.enumeration.sameSetAndOrder && r.enumeration.ascending);
assert.equal(r.requests.organizer.status, 'PASS', JSON.stringify(r.requests.organizer.failed));
assert.ok(r.flood.outputs >= 3000, `${r.flood.outputs} flood outputs`);
assert.ok(r.flood.accountAddressesAfter - r.flood.accountAddressesBefore >= 3000);
assert.equal(r.flood.withdrawalRowsAfter, r.flood.withdrawalRowsBefore);
assert.equal(r.flood.verification.status, 'PASS', JSON.stringify(r.flood.verification.failed));
assert.equal(r.flood.verification.requests, r.requests.organizer.requests);
assert.deepEqual(r.flood.verification.byEndpoint, r.requests.organizer.byEndpoint);
assert.deepEqual([r.cli.pass.exit, r.cli.pass.status], [0, 'PASS']);
assert.deepEqual([r.cli.tampered.exit, r.cli.tampered.status], [1, 'FAIL']);
assert.equal(r.cli.withoutIndexer.exit, 2);
assert.deepEqual([r.overlap.exit, r.overlap.status], [1, 'FAIL']);
assert.deepEqual(r.overlap.conflicts, [r.overlap.txHash]);
assert.deepEqual([r.enterprise.exit, r.enterprise.status], [1, 'FAIL']);
assert.match(r.enterprise.evidence.detail, /must be a base address with a stake key/);
assert.equal(r.enterprise.requests, 0);
assert.deepEqual([r.other.exit, r.other.status], [0, 'PASS']);
