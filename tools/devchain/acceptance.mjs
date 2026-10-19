// Plan step 8b acceptance on a fresh dev chain (tools/devchain/dolos.toml), test keys only. Usage, with Dolos running
// and `make build` done:
//   node tools/devchain/acceptance.mjs <out dir>
// Writes into <out dir>: report.json (printed too), captures.json (MiniBF answers the adapter and the page rely on,
// copied into docs/plans/2026-10-18-hardening-and-backend/dolos-1.6.1-adapter-captures.json) and the proofs the CLI
// verified. Covers: two read-only enumerations of one identity below one height (set, order, count = sent), CLI
// --indexer PASS and tampered FAIL, CLI without --indexer, an overlapping commitment from the identity's second
// address, an enterprise (payment credential) identity, and the requests one full verification makes against n.
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ALGORITHM,
  BlockfrostChain,
  commitmentValidUntil,
  FIXTURE,
  identityKeyHash,
  identityOf,
  preprodSlotAt,
  QUICKNET,
  selectWinners,
  VERSION,
  verifyProof,
} from '@giveaway/verifier-cli/library';
import {
  BASE,
  build,
  commitment,
  fanOut,
  GENESIS,
  get,
  paymentCredential,
  submit,
  utxos,
  waitFor,
  WALLETS,
} from './devchain.mjs';

const out = process.argv[2];
if (!out) throw new Error('Usage: node tools/devchain/acceptance.mjs <out dir>');
await mkdir(out, { recursive: true });
const root = fileURLToPath(new URL('../../', import.meta.url));
const log = (...args) => console.error(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { base: BASE, version: (await get('/')).body };
const captures = {};
const capture = async (name, path, init) => {
  const response = init
    ? await fetch(`${BASE}${path}`, init).then(async (r) => ({
        status: r.status,
        headers: Object.fromEntries(r.headers),
        body: await r.text(),
      }))
    : await get(path);
  delete response.headers.date;
  captures[name] = { path, method: init?.method ?? 'GET', ...response };
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
// Every transaction this script sends that touches the organizer identity (stake key 2), in order.
const sent = new Set();
const send = async (tx) => {
  const r = await submit(tx.cbor);
  if (r.status !== 200) throw new Error(`submit rejected: ${r.status} ${r.body}`);
  return tx.txHash;
};

// 1. Funding and history: the organizer's base address gets 3 fan-outs of 100 UTxOs, then sends 260 plain
// self-transfers, submitted 30 at a time so blocks (at most 10 transactions) hold several.
log('funding');
for (let i = 0; i < 3; i++) sent.add(await fanOut(GENESIS[1], 100, 50_000_000n, WALLETS.organizer));
sent.add(await fanOut(GENESIS[6], 5, 50_000_000n, WALLETS.organizerSecond));
const pool = (await utxos(WALLETS.organizer.address)).filter((u) => u.lovelace === 50_000_000n);
log('history');
const HISTORY = Number(process.env.ACCEPTANCE_TXS ?? 260);
for (let start = 0; start < HISTORY; start += 30) {
  const batch = [];
  for (let i = start; i < Math.min(HISTORY, start + 30); i++)
    batch.push(
      await build({ from: WALLETS.organizer, inputs: [pool[i]], outputs: [[WALLETS.organizer.hex, 2_000_000n]] }),
    );
  for (const tx of batch) sent.add(await send(tx));
  await Promise.all(batch.map((tx) => waitFor(tx.txHash)));
}

// 2. The commitment under test, built as the page builds it: identity key as the only required signer and
// invalid_hereafter at commitmentValidUntil(round) on the pinned preprod clock.
async function commit(wallet, drawId, input) {
  const b = bundle(drawId);
  const tx = await build({
    from: wallet,
    inputs: [input],
    outputs: [[wallet.hex, 2_000_000n]],
    metadata: await commitment(b),
    signers: [identityKeyHash(wallet.address)],
    invalidHereafter: preprodSlotAt(commitmentValidUntil(b.drand.round)),
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
while ((await get('/blocks/latest')).body.height < target.included.block_height + 14) await sleep(1000);
const tip = (await get('/blocks/latest')).body.height;

// 3. Read-only enumeration of the organizer identity, twice below the same height (PD9: account addresses, then
// every address), compared with what was sent.
async function enumerateIdentity(upTo) {
  const stake = identityOf(WALLETS.organizer.address).key;
  const addresses = [];
  for (let page = 1; ; page++) {
    const r = await get(`/accounts/${stake}/addresses?count=100&page=${page}`);
    if (r.status !== 200) throw new Error(`accounts/addresses ${r.status}`);
    addresses.push(...r.body.map((x) => x.address));
    if (r.body.length < 100) break;
  }
  const rows = [];
  for (const address of addresses)
    for (let page = 1; ; page++) {
      const r = await get(`/addresses/${address}/transactions?order=asc&count=100&page=${page}&to=${upTo}`);
      if (r.status !== 200) throw new Error(`addresses/transactions ${r.status}`);
      rows.push(...r.body);
      if (r.body.length < 100) break;
    }
  const merged = new Map(rows.map((r) => [r.tx_hash, r]));
  return {
    addresses,
    rows: rows.length,
    order: [...merged.values()]
      .sort((a, b) => a.block_height - b.block_height || a.tx_index - b.tx_index)
      .map((r) => `${r.block_height}:${r.tx_index}:${r.tx_hash}`),
  };
}
log('enumeration');
{
  const first = await enumerateIdentity(tip);
  await sleep(3000);
  const second = await enumerateIdentity(tip);
  const listed = new Set(first.order.map((k) => k.split(':')[2]));
  report.enumeration = {
    height: tip,
    addresses: first.addresses.length,
    rows: first.rows,
    distinct: first.order.length,
    sent: sent.size,
    missingSent: [...sent].filter((h) => !listed.has(h)).length,
    notSent: [...listed].filter((h) => !sent.has(h)).length,
    sameSetAndOrder: JSON.stringify(first.order) === JSON.stringify(second.order),
    blocksWithSeveral: [...Map.groupBy(first.order, (k) => k.split(':')[0]).values()].filter((x) => x.length > 1)
      .length,
  };
}

// 4. Requests of one full verification through the adapter, by endpoint, against n.
async function countedVerification(proof) {
  const calls = [];
  const chain = new BlockfrostChain(BASE, (input, init) => {
    calls.push(
      new URL(input).pathname
        .replace(/[a-f0-9]{64}/, '{h}')
        .replace(/addr_test1\w+|addr_vkh1\w+|stake_test1\w+/, '{a}'),
    );
    return fetch(input, init);
  });
  const started = performance.now();
  const verdict = await verifyProof(proof, { chain });
  const ms = Math.round(performance.now() - started);
  const byEndpoint = {};
  for (const c of calls) byEndpoint[c] = (byEndpoint[c] ?? 0) + 1;
  return { status: verdict.status, conflicts: verdict.conflicts, requests: calls.length, byEndpoint, ms };
}
log('verification');
report.requests = { organizer: { n: report.enumeration.distinct, ...(await countedVerification(target.proof)) } };
report.requestsAgain = (await countedVerification(target.proof)).requests;

// 5. CLI: --indexer at the dev chain PASS; tampered bundle FAIL; no --indexer refused.
const cli = (file, ...extra) =>
  spawnSync(process.execPath, [`${root}apps/verifier-cli/index.mjs`, file, ...extra], { encoding: 'utf8' });
const write = async (name, value) => {
  const file = `${out}/${name}`;
  await writeFile(file, JSON.stringify(value, null, 2));
  return file;
};
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
  const verdict = (r) => (r.stdout ? JSON.parse(r.stdout) : null);
  report.cli = {
    pass: {
      exit: pass.status,
      status: verdict(pass)?.status,
      checks: verdict(pass)?.checks.map((c) => `${c.name}: ${c.result}`),
    },
    tampered: {
      exit: fail.status,
      status: verdict(fail)?.status,
      failed: verdict(fail)
        ?.checks.filter((c) => c.result !== 'pass')
        .map((c) => `${c.name}: ${c.result}`),
    },
    withoutIndexer: { exit: none.status, stderr: none.stderr.trim() },
  };
}

// 6. The same identity commits again from its second payment address while the first is open: both addresses are
// listed under the stake account, so the merged history shows the conflict.
log('conflict');
{
  const [input] = await utxos(WALLETS.organizerSecond.address);
  const second = await commit(WALLETS.organizerSecond, 'devchain-overlap', input);
  while ((await get('/blocks/latest')).body.height < second.included.block_height + 14) await sleep(1000);
  const file = await write('proof-after-overlap.json', target.proof);
  const r = cli(file, '--indexer', BASE);
  const v = r.stdout ? JSON.parse(r.stdout) : null;
  report.overlap = {
    txHash: second.tx.txHash,
    exit: r.status,
    status: v?.status,
    conflicts: v?.conflicts.map((c) => c.txHash),
    unique: v?.checks.find((c) => c.name === 'Unique commitment'),
  };
}

// 7. An enterprise address: the identity is its payment credential, enumerated as addr_vkh.
log('enterprise');
{
  // Not a genesis UTxO: Dolos 1.6.1 reports an input spending a genesis UTxO with address "" in /txs/{h}/utxos
  // (measured), so the organizer-input check could not see it. The commitment spends an output of a real transaction.
  // The first funding transaction spends a genesis UTxO.
  const genesisInput = await get(`/txs/${[...sent][0]}/utxos`);
  const funding = await fanOut(WALLETS.enterprise, 2, 50_000_000n);
  const [input] = (await utxos(WALLETS.enterprise.address)).filter((u) => u.txHash === funding);
  report.genesisInputAddress = genesisInput.body.inputs.map((x) => x.address);
  const committed = await commit(WALLETS.enterprise, 'devchain-enterprise', input);
  while ((await get('/blocks/latest')).body.height < committed.included.block_height + 14) await sleep(1000);
  const file = await write('proof-enterprise.json', committed.proof);
  const r = cli(file, '--indexer', BASE);
  report.enterprise = {
    exit: r.status,
    status: r.stdout ? JSON.parse(r.stdout).status : null,
    requests: await countedVerification(committed.proof),
  };
}

// 8. MiniBF answers the adapter, the page and the mocks rely on.
log('captures');
{
  const stake = identityOf(WALLETS.organizer.address).key;
  await capture('epochs-latest-parameters', '/epochs/latest/parameters');
  await capture('accounts-addresses', `/accounts/${stake}/addresses?count=100&page=1`);
  await capture('accounts-addresses-past-end', `/accounts/${stake}/addresses?count=100&page=2`);
  await capture(
    'accounts-addresses-unknown',
    `/accounts/${identityOf(WALLETS.other.address).key}/addresses?count=100&page=1`,
  );
  await capture(
    'address-unknown-transactions',
    `/addresses/${WALLETS.other.address}/transactions?order=asc&count=100&page=1`,
  );
  await capture(
    'vkh-transactions',
    `/addresses/${paymentCredential(WALLETS.enterprise.keys[0].hash)}/transactions?order=asc&count=100&page=1`,
  );
  for (const p of ['', '/cbor', '/utxos', '/metadata'])
    await capture(`commitment${p.replace('/', '-') || '-info'}`, `/txs/${target.tx.txHash}${p}`);
  await capture('blocks-latest', '/blocks/latest');
  await capture('confirmation-block', `/blocks/${target.included.block_height + 14}`);
}
await writeFile(`${out}/captures.json`, `${JSON.stringify(captures, null, 2)}\n`);
await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
