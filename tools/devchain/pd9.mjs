// Plan step 8b supplementary measurements for PD9 and PD10 on a fresh dev chain (tools/devchain/dolos.toml), test
// keys only. Usage, with Dolos running: node tools/devchain/pd9.mjs > report.json
//   1. A fully spent address is still listed by /accounts/{stake}/addresses (PD9 completeness).
//   2. One transaction paying three addresses under the same stake: rows 3, distinct transactions 1 (PD9 dedup).
//   3. The cost of pushing an identity's enumerated rows past a cap (PD10): one transaction paying as many distinct
//      "attacker payment + organizer stake" addresses as the maximum transaction size allows.
// Results: docs/plans/2026-10-18-hardening-and-backend/spike-dolos.md.
import { ed25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { encodeBech32 } from '@giveaway/verifier-cli/library';
import { hex, testKey, unhex } from '../../tests/cardano.mjs';
import { build, fanOut, GENESIS, get, stakeAddress, submit, utxos, waitFor, WALLETS } from './devchain.mjs';

const log = (...args) => console.error(new Date().toISOString(), ...args);
const report = {};
const ORGANIZER_STAKE = testKey(2);
const stake = stakeAddress(ORGANIZER_STAKE.hash);
const baseUnder = (payment, stakeHash = ORGANIZER_STAKE.hash) => {
  const h = `00${payment.hash}${stakeHash}`;
  return { hex: h, address: encodeBech32('addr_test', unhex(h)), keys: [payment] };
};
// Keys beyond the 255 seed-filled test keys: the secret is blake2b-256 of a label and an index.
const derivedKey = (i) => {
  const secret = blake2b(new TextEncoder().encode(`pd10-attacker:${i}`), { dkLen: 32 });
  const publicKey = ed25519.getPublicKey(secret);
  return { secret, publicKey, hash: hex(blake2b(publicKey, { dkLen: 28 })) };
};

async function pages(path) {
  const rows = [];
  let requests = 0;
  for (let page = 1; ; page++) {
    const r = await get(`${path}${path.includes('?') ? '&' : '?'}count=100&page=${page}`);
    requests++;
    if (r.status !== 200) return { rows, requests, error: { status: r.status, body: r.body } };
    rows.push(...r.body);
    if (r.body.length < 100) return { rows, requests };
  }
}
// The PD9 enumeration of a stake identity, as the adapter does it: address list, then every address.
async function stakeRows() {
  const listed = await pages(`/accounts/${stake}/addresses`);
  if (listed.error) throw new Error(`accounts/addresses ${listed.error.status}`);
  const addresses = listed.rows.map((x) => x.address);
  let rows = 0,
    requests = listed.requests;
  const distinct = new Set();
  const perTx = new Map();
  for (const address of addresses) {
    const txs = await pages(`/addresses/${address}/transactions?order=asc`);
    requests += txs.requests;
    if (txs.error) throw new Error(`addresses/transactions ${txs.error.status}`);
    rows += txs.rows.length;
    for (const r of txs.rows) {
      distinct.add(r.tx_hash);
      perTx.set(r.tx_hash, (perTx.get(r.tx_hash) ?? 0) + 1);
    }
  }
  return { addresses, rows, distinct: distinct.size, requests, perTx };
}

// 1. A fully spent address: fund payment 8 + stake 2 with one output, then spend that output entirely elsewhere.
log('spent address');
{
  const spent = baseUnder(testKey(8));
  spent.keys = [testKey(8)];
  const funding = await fanOut(GENESIS[4], 1, 10_000_000n, spent);
  const [input] = await utxos(spent.address);
  const tx = await build({ from: spent, inputs: [input], outputs: [], change: WALLETS.other.hex });
  const r = await submit(tx.cbor);
  if (r.status !== 200) throw new Error(`spend rejected ${r.status} ${r.body}`);
  await waitFor(tx.txHash);
  const remaining = await get(`/addresses/${spent.address}/utxos?count=100&page=1`);
  const listing = await get(`/accounts/${stake}/addresses?count=100&page=1`);
  const history = await get(`/addresses/${spent.address}/transactions?order=asc&count=100&page=1`);
  report.spentAddress = {
    address: spent.address,
    fundingTx: funding,
    spendingTx: tx.txHash,
    utxosAfter: { status: remaining.status, body: remaining.body },
    listedByAccountAddresses: Array.isArray(listing.body) && listing.body.some((x) => x.address === spent.address),
    accountAddresses: listing.body,
    addressTransactions: {
      status: history.status,
      hashes: Array.isArray(history.body) ? history.body.map((x) => x.tx_hash) : history.body,
    },
  };
}

// 2. One transaction paying three different addresses that share the organizer stake.
log('three addresses');
{
  const targets = [WALLETS.organizer, WALLETS.organizerSecond, baseUnder(testKey(9))];
  const [input] = (await utxos(GENESIS[1].address)).sort((x, y) => (x.lovelace > y.lovelace ? -1 : 1));
  const tx = await build({
    from: GENESIS[1],
    inputs: [input],
    outputs: targets.map((t) => [t.hex, 3_000_000n]),
  });
  const r = await submit(tx.cbor);
  if (r.status !== 200) throw new Error(`three-address rejected ${r.status} ${r.body}`);
  await waitFor(tx.txHash);
  const enumerated = await stakeRows();
  report.threeAddresses = {
    txHash: tx.txHash,
    targets: targets.map((t) => t.address),
    rowsForThisTx: enumerated.perTx.get(tx.txHash) ?? 0,
    identity: { addresses: enumerated.addresses.length, rows: enumerated.rows, distinct: enumerated.distinct },
  };
}

// 3. PD10: the largest transaction paying distinct attacker-payment + organizer-stake addresses, 1 ADA each.
log('pd10');
{
  const params = (await get('/epochs/latest/parameters')).body;
  const each = 1_000_000n;
  const outputsFor = (k, offset) => Array.from({ length: k }, (_, i) => [baseUnder(derivedKey(offset + i)).hex, each]);
  const [funding] = (await utxos(GENESIS[3].address)).sort((x, y) => (x.lovelace > y.lovelace ? -1 : 1));
  const attacker = { hex: `60${testKey(3).hash}`, keys: [testKey(3)] };
  // Largest k whose signed transaction fits max_tx_size.
  let lo = 1,
    hi = 400;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const tx = await build({ from: attacker, inputs: [funding], outputs: outputsFor(mid, 0) });
    if (tx.cbor.length / 2 <= params.max_tx_size) lo = mid;
    else hi = mid - 1;
  }
  const before = await stakeRows();
  const sent = [];
  let input = funding;
  for (let n = 0; n < 2; n++) {
    const tx = await build({ from: attacker, inputs: [input], outputs: outputsFor(lo, n * lo) });
    const r = await submit(tx.cbor);
    if (r.status !== 200) throw new Error(`pd10 rejected ${r.status} ${r.body}`);
    await waitFor(tx.txHash);
    const fee = (await get(`/txs/${tx.txHash}`)).body.fees;
    sent.push({ txHash: tx.txHash, bytes: tx.cbor.length / 2, fee });
    // The change output is the last one: spend it in the next transaction.
    input = {
      txHash: tx.txHash,
      index: lo,
      lovelace: BigInt((await get(`/txs/${tx.txHash}/utxos`)).body.outputs[lo].amount[0].quantity),
    };
  }
  const after = await stakeRows();
  report.pd10 = {
    params: {
      min_fee_a: params.min_fee_a,
      min_fee_b: params.min_fee_b,
      max_tx_size: params.max_tx_size,
      coins_per_utxo_size: params.coins_per_utxo_size,
    },
    outputsPerTx: lo,
    lovelacePerOutput: Number(each),
    transactions: sent,
    before: {
      addresses: before.addresses.length,
      rows: before.rows,
      distinct: before.distinct,
      requests: before.requests,
    },
    after: { addresses: after.addresses.length, rows: after.rows, distinct: after.distinct, requests: after.requests },
    rowsAddedPerTx: (after.rows - before.rows) / sent.length,
  };
}

// 4. The address list itself spans several pages now: is its order stable across repeats and page sizes?
log('address list paging');
{
  const list = async (count) => {
    const all = [];
    let requests = 0;
    for (let page = 1; ; page++) {
      const r = await get(`/accounts/${stake}/addresses?count=${count}&page=${page}`);
      requests++;
      if (r.status !== 200) throw new Error(`accounts/addresses ${r.status}`);
      all.push(...r.body.map((x) => x.address));
      if (r.body.length < count) return { all, requests };
    }
  };
  const [first, second, small] = [await list(100), await list(100), await list(10)];
  report.addressListPaging = {
    addresses: first.all.length,
    distinct: new Set(first.all).size,
    requests: { count100: first.requests, count10: small.requests },
    repeatSameOrder: JSON.stringify(first.all) === JSON.stringify(second.all),
    count10SameOrder: JSON.stringify(first.all) === JSON.stringify(small.all),
    sortedLexically: first.all.every((a, i, xs) => i === 0 || xs[i - 1] < a),
  };
}
console.log(JSON.stringify(report, null, 2));
