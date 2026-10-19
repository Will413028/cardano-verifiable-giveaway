// Plan step 8b measurements on a fresh dev chain (tools/devchain/dolos.toml). Usage, with Dolos running:
//   node tools/devchain/spike.mjs <captures.json>
// Prints one JSON report and writes the raw MiniBF responses it saw to <captures.json>.
// Results: docs/plans/2026-10-18-hardening-and-backend/spike-dolos.md.
import { writeFile } from 'node:fs/promises';
import { identityKeyHash, LABEL, VERSION, QUICKNET, FIXTURE, ALGORITHM } from '@giveaway/verifier-cli/library';
import {
  BASE,
  build,
  commitment,
  fanOut,
  GENESIS,
  get,
  paymentCredential,
  stakeAddress,
  submit,
  utxos,
  waitFor,
  WALLETS,
} from './devchain.mjs';

const out = process.argv[2];
if (!out) throw new Error('Usage: node tools/devchain/spike.mjs <captures.json>');
const report = { base: BASE };
const captures = {};
const capture = async (name, path, init) => {
  const response = init
    ? await fetch(`${BASE}${path}`, init).then(async (r) => ({
        status: r.status,
        headers: Object.fromEntries(r.headers),
        body: await r.text(),
      }))
    : await get(path);
  captures[name] = { path, method: init?.method ?? 'GET', ...response };
  return response;
};
const log = (...args) => console.error(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bundle = (drawId) => ({
  version: VERSION,
  algorithm: ALGORITHM,
  drawId,
  entrants: ['alice', 'bob', 'carol'],
  rules: { winners: 1 },
  drand: { chainHash: QUICKNET, round: FIXTURE.round },
});

// 1. Funding: genesis enterprise UTxOs fan out to the wallets under test.
const N = Number(process.env.SPIKE_TXS ?? 260);
const sent = { organizer: [], enterprise: [] };
log('funding');
for (let i = 0; i < 3; i++) sent.organizer.push(await fanOut(GENESIS[1], 100, 50_000_000n, WALLETS.organizer));
for (let i = 0; i < 3; i++) sent.enterprise.push(await fanOut(WALLETS.enterprise, 100, 50_000_000n));
await fanOut(GENESIS[3], 2, 50_000_000n, WALLETS.thirdParty);
await fanOut(GENESIS[6], 25, 50_000_000n, WALLETS.organizerSecond);

// 2. Bursts: N transactions per identity, submitted 30 at a time so blocks (at most 10 transactions) hold several.
async function burst(wallet, list, signerHash) {
  const available = (await utxos(wallet.address)).filter((u) => u.lovelace === 50_000_000n);
  if (available.length < N) throw new Error(`only ${available.length} UTxOs for ${wallet.address}`);
  for (let start = 0; start < N; start += 30) {
    const batch = [];
    for (let i = start; i < Math.min(N, start + 30); i++) {
      // Every fifth transaction is commitment-shaped (label, identity key as required signer, validity bound).
      const committed = i % 5 === 0;
      const tx = await build({
        from: wallet,
        inputs: [available[i]],
        outputs: [[wallet.hex, 2_000_000n]],
        metadata: committed ? await commitment(bundle(`spike-${wallet.hex.slice(0, 4)}-${i}`)) : null,
        signers: committed ? [signerHash] : [],
        invalidHereafter: committed ? 200_000_000n : null,
      });
      batch.push(tx);
    }
    const results = await Promise.all(batch.map((tx) => submit(tx.cbor)));
    results.forEach((r, j) => {
      if (r.status !== 200) throw new Error(`submit rejected: ${r.status} ${r.body}`);
      list.push(batch[j].txHash);
    });
    await Promise.all(batch.map((tx) => waitFor(tx.txHash)));
  }
}
log('bursts');
await burst(WALLETS.organizer, sent.organizer, identityKeyHash(WALLETS.organizer.address));
await burst(WALLETS.enterprise, sent.enterprise, identityKeyHash(WALLETS.enterprise.address));

// 3. Enumeration endpoints.
const stake = stakeAddress(WALLETS.organizer.keys[1].hash);
const vkh = paymentCredential(WALLETS.enterprise.keys[0].hash);
report.endpoints = {};
for (const [name, path] of [
  ['accounts-transactions', `/accounts/${stake}/transactions?order=asc&count=100&page=1`],
  ['addresses-stake-transactions', `/addresses/${stake}/transactions?order=asc&count=100&page=1`],
  ['accounts-addresses', `/accounts/${stake}/addresses?count=100&page=1`],
  ['addresses-vkh-transactions', `/addresses/${vkh}/transactions?order=asc&count=100&page=1`],
  ['addresses-base-transactions', `/addresses/${WALLETS.organizer.address}/transactions?order=asc&count=100&page=1`],
]) {
  const r = await capture(name, path);
  report.endpoints[name] = { status: r.status, items: Array.isArray(r.body) ? r.body.length : null };
}
// `list` is the enumeration path: /addresses/{address}/transactions or /accounts/{stake}/transactions.
async function enumerate(list, count, { upTo } = {}) {
  const rows = [];
  let requests = 0;
  for (let page = 1; ; page++) {
    const suffix = upTo ? `&to=${upTo}` : '';
    const r = await get(`${list}?order=asc&count=${count}&page=${page}${suffix}`);
    requests++;
    if (r.status !== 200) return { rows, requests, error: { status: r.status, body: r.body } };
    rows.push(...r.body);
    if (r.body.length < count) return { rows, requests };
  }
}
const key = (r) => `${r.block_height}:${r.tx_index}:${r.tx_hash}`;
function compare(name, a, b) {
  return {
    name,
    lengths: [a.rows.length, b.rows.length],
    sameOrder: JSON.stringify(a.rows.map(key)) === JSON.stringify(b.rows.map(key)),
    duplicates: a.rows.length - new Set(a.rows.map((r) => r.tx_hash)).size,
  };
}
async function enumeration(label, list, submitted) {
  const tip = (await get('/blocks/latest')).body.height;
  const first = await enumerate(list, 100, { upTo: tip });
  const second = await enumerate(list, 100, { upTo: tip });
  const small = await enumerate(list, 10, { upTo: tip });
  const hashes = new Set(first.rows.map((r) => r.tx_hash));
  const perBlock = {};
  for (const r of first.rows) perBlock[r.block_height] = (perBlock[r.block_height] ?? 0) + 1;
  const inBlockOrder = first.rows.every(
    (r, i, all) =>
      i === 0 ||
      all[i - 1].block_height < r.block_height ||
      (all[i - 1].block_height === r.block_height && all[i - 1].tx_index < r.tx_index),
  );
  return {
    label,
    tip,
    errors: [first.error, second.error, small.error].filter(Boolean),
    submitted: submitted.length,
    listed: first.rows.length,
    missingSubmitted: submitted.filter((h) => !hashes.has(h)).length,
    requests: { count100: first.requests, count10: small.requests },
    repeat: compare('count=100 twice', first, second),
    pageSize: compare('count=100 vs count=10', first, small),
    inBlockOrder,
    blocksWithSeveral: Object.values(perBlock).filter((n) => n > 1).length,
    maxPerBlock: Math.max(...Object.values(perBlock)),
    sample: first.rows.slice(0, 3),
  };
}
log('enumeration');
report.enumeration = [
  await enumeration('payment credential (addr_vkh)', `/addresses/${vkh}/transactions`, sent.enterprise),
  await enumeration('organizer base address', `/addresses/${WALLETS.organizer.address}/transactions`, sent.organizer),
];
// Only where the node serves it (not Dolos 1.6.1): every transaction of the organizer stake credential.
if (report.endpoints['accounts-transactions'].status === 200)
  report.enumeration.push(await enumeration('stake account', `/accounts/${stake}/transactions`, sent.organizer));
// A stake credential enumerated without /accounts/{stake}/transactions: list the addresses that ever received an
// output under it, enumerate each address, merge by (block height, index) and drop duplicates.
{
  const tip = (await get('/blocks/latest')).body.height;
  const addresses = [];
  let requests = 0;
  for (let page = 1; ; page++) {
    const r = await get(`/accounts/${stake}/addresses?count=100&page=${page}`);
    requests++;
    if (r.status !== 200) throw new Error(`accounts/addresses ${r.status}`);
    addresses.push(...r.body.map((x) => x.address));
    if (r.body.length < 100) break;
  }
  const rows = new Map();
  for (const address of addresses) {
    const listed = await enumerate(`/addresses/${address}/transactions`, 100, { upTo: tip });
    requests += listed.requests;
    if (listed.error) throw new Error(`addresses/transactions ${listed.error.status}`);
    for (const row of listed.rows) rows.set(row.tx_hash, row);
  }
  const merged = [...rows.values()].sort((a, b) => a.block_height - b.block_height || a.tx_index - b.tx_index);
  const hashes = new Set(merged.map((r) => r.tx_hash));
  report.stakeViaAddresses = {
    tip,
    addresses: addresses.length,
    listed: merged.length,
    missingSubmitted: sent.organizer.filter((h) => !hashes.has(h)).length,
    requests,
  };
}
// Stable while the chain grows: re-run the bounded enumeration after more blocks.
await sleep(5000);
report.enumerationLater = await enumeration(
  'payment credential (addr_vkh), 5 s later',
  `/addresses/${vkh}/transactions`,
  sent.enterprise,
);

// 4. max_scan_items (dolos.toml: 100000) and the count cap.
report.scan = {};
for (const [name, query] of [
  ['scan-at-limit', 'count=100&page=1000'],
  ['scan-over-limit', 'count=100&page=1001'],
  ['count-over-100', 'count=101&page=1'],
  ['page-past-end', 'count=100&page=50'],
]) {
  const r = await capture(name, `/addresses/${vkh}/transactions?order=asc&${query}`);
  report.scan[name] = { status: r.status, body: Array.isArray(r.body) ? `${r.body.length} items` : r.body };
}

// 5. A payment credential (and stake part) that appears only in an input: the third party's address
// (payment 3, the organizer's stake part) spends everything to another wallet, no change.
log('input-only');
{
  const [input] = await utxos(WALLETS.thirdParty.address);
  const tx = await build({
    from: WALLETS.thirdParty,
    inputs: [input],
    outputs: [[WALLETS.other.hex, 10_000_000n]],
    change: WALLETS.other.hex,
  });
  const r = await submit(tx.cbor);
  if (r.status !== 200) throw new Error(`input-only rejected ${r.status} ${r.body}`);
  await waitFor(tx.txHash);
  const payment = paymentCredential(WALLETS.thirdParty.keys[0].hash);
  const listed = await enumerate(`/addresses/${payment}/transactions`, 100);
  const stakeListed = await enumerate(`/accounts/${stake}/transactions`, 100);
  report.inputOnly = {
    txHash: tx.txHash,
    paymentCredentialListsIt: listed.rows.some((x) => x.tx_hash === tx.txHash),
    accountsTransactions: {
      status: stakeListed.error?.status ?? 200,
      listsIt: stakeListed.error ? null : stakeListed.rows.some((x) => x.tx_hash === tx.txHash),
    },
  };
}

// 6. Fresh transactions: poll their reads every 20 ms from submission until all answer 200, recording each change of
// state, to see whether the transaction is ever listed (/txs/{h}) while its CBOR is not served.
log('fresh');
{
  const samples = Number(process.env.SPIKE_FRESH ?? 20);
  const inputs = (await utxos(WALLETS.organizerSecond.address)).filter((u) => u.lovelace === 50_000_000n);
  const paths = ['', '/cbor', '/utxos', '/metadata'];
  report.fresh = { samples: [], listedWithoutCbor: 0 };
  let last;
  for (let k = 0; k < samples; k++) {
    const tx = await build({
      from: WALLETS.organizerSecond,
      inputs: [inputs[k]],
      outputs: [[WALLETS.organizerSecond.hex, 2_000_000n]],
      metadata: await commitment(bundle(`spike-fresh-${k}`)),
      signers: [identityKeyHash(WALLETS.organizerSecond.address)],
      invalidHereafter: 200_000_000n,
    });
    const started = Date.now();
    const submitted = await capture('tx-submit', '/tx/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/cbor' },
      body: Uint8Array.from(tx.cbor.match(/../g), (b) => parseInt(b, 16)),
    });
    if (submitted.status !== 200) throw new Error(`fresh submit ${submitted.status} ${submitted.body}`);
    const timeline = [];
    let state;
    for (let i = 0; i < 1000; i++) {
      const statuses = await Promise.all(paths.map((p) => get(`/txs/${tx.txHash}${p}`).then((r) => r.status)));
      if (statuses.join() !== state)
        timeline.push({
          ms: Date.now() - started,
          statuses: Object.fromEntries(paths.map((p, j) => [p || '/', statuses[j]])),
        });
      state = statuses.join();
      if (statuses[0] === 200 && statuses[1] !== 200) report.fresh.listedWithoutCbor++;
      if (statuses.every((s) => s === 200)) break;
      await sleep(20);
    }
    report.fresh.samples.push({ txHash: tx.txHash, timeline });
    last = tx;
  }
  const included = await waitFor(last.txHash);
  for (const p of paths) await capture(`tx${p.replace('/', '-') || '-info'}`, `/txs/${last.txHash}${p}`);
  await capture('block-of-tx', `/blocks/${included.block_height}`);
  await capture('confirmation-block', `/blocks/${included.block_height + 14}`);
  await capture('tx-metadata-none', `/txs/${sent.organizer[1]}/metadata`);
}

// 7. Unknown transaction, CORS, storage mode and the earliest block.
const unknown = 'ab'.repeat(32);
for (const p of ['', '/cbor', '/utxos', '/metadata'])
  await capture(`unknown-tx${p.replace('/', '-')}`, `/txs/${unknown}${p}`);
await capture('unknown-block', '/blocks/99999999');
await capture('blocks-latest', '/blocks/latest');
await capture('preflight', `/txs/${unknown}/cbor`, {
  method: 'OPTIONS',
  headers: { Origin: 'http://127.0.0.1:4320', 'Access-Control-Request-Method': 'GET' },
});
for (const p of ['/', '/health', '/genesis', '/network', '/network/eras', '/blocks/0', '/blocks/1'])
  await capture(`meta${p.replaceAll('/', '-')}`, p);
await capture('address-utxos', `/addresses/${WALLETS.organizer.address}/utxos?count=2&page=1`);
await capture(
  'vkh-unknown',
  `/addresses/${paymentCredential('00'.repeat(28))}/transactions?order=asc&count=100&page=1`,
);
report.label = LABEL;
await writeFile(out, `${JSON.stringify(captures, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
