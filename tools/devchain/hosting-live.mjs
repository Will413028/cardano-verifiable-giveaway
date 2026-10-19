// Plan step 10, live check of the upload gate: the backend (apps/api under `wrangler dev`, local D1 and R2) reading the
// real Dolos dev chain, nothing mocked; test keys only. Usage, with a fresh Dolos dev chain running and `make build`
// done:
//   node tools/devchain/hosting-live.mjs <run dir>
// <run dir> receives Wrangler's local state and log. Starts and stops its own `wrangler dev` (port API_PORT, default
// 8797). Prints the report (copied into docs/plans/2026-10-18-hardening-and-backend/dolos-1.6.1-hosting-live-report.json)
// and exits 1 when an expectation fails. Covers: a commitment uploaded before its 15 confirmations (refused, retry
// later), after them (hosted for the identity read from the transaction), served back byte for byte; other bytes
// under the same transaction (hash mismatch); an unknown transaction; a second identity committing the same bundle
// hash (its own record, the same stored bytes); and the CLI bundle mode on the served bytes against the same chain.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ALGORITHM,
  canonicalize,
  commitmentValidUntil,
  computeCommitment,
  identityOf,
  preprodSlotAt,
  QUICKNET,
  roundAt,
  VERSION,
} from '@giveaway/verifier-cli/library';
import { BASE, build, commitment, fanOut, GENESIS, get, submit, utxos, waitFor, WALLETS } from './devchain.mjs';
import { balanced, regCert, voteDelegAbstain } from './withdrawal-tx.mjs';

const runDir = process.argv[2];
if (!runDir) throw new Error('Usage: node tools/devchain/hosting-live.mjs <run dir>');
await mkdir(runDir, { recursive: true });
const root = fileURLToPath(new URL('../../', import.meta.url));
const API_PORT = Number(process.env.API_PORT ?? 8797);
const API = `http://127.0.0.1:${API_PORT}`;
const PAGE = 'http://127.0.0.1:4320';
const log = (...args) => console.error(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { dolos: BASE, api: API, version: (await get('/')).body, checks: {} };
const params = (await get('/epochs/latest/parameters')).body;
const fees = { a: BigInt(params.min_fee_a), b: BigInt(params.min_fee_b) };
// A round produced an hour ago: within the 12 hosting months that follow it, and after every dev chain block (the dev
// chain clock starts at 2022-06-01, tools/devchain/dolos.toml). The CLI fetches its beacon from the drand relays.
const ROUND = roundAt(Math.floor(Date.now() / 1000) - 3600);
report.round = ROUND;
const bundle = (drawId) => ({
  version: VERSION,
  algorithm: ALGORITHM,
  drawId,
  entrants: ['alice', 'bob', 'carol', 'dana'],
  rules: { winners: 2 },
  drand: { chainHash: QUICKNET, round: ROUND },
});
const send = async (tx) => {
  const r = await submit(tx.cbor);
  if (r.status !== 200) throw new Error(`submit rejected: ${r.status} ${r.body}`);
  return waitFor(tx.txHash);
};

// Chain: two identities funded, registered and delegated (as the page requires), each committing the same bundle.
log('funding and registration');
await fanOut(GENESIS[1], 4, 50_000_000n, WALLETS.organizer);
await fanOut(GENESIS[4], 4, 50_000_000n, WALLETS.other);
for (const wallet of [WALLETS.organizer, WALLETS.other]) {
  const stake = wallet.keys[1];
  const [input] = await utxos(wallet.address);
  await send(
    balanced(
      {
        inputs: [input],
        change: wallet.hex,
        certs: [regCert(stake.hash, params.key_deposit), voteDelegAbstain(stake.hash)],
        witnesses: wallet.keys,
      },
      { ...fees, pallasRule: true },
    ),
  );
}
const hosted = bundle('hosting-live');
const bytes = canonicalize(hosted);
async function commit(wallet) {
  const [input] = (await utxos(wallet.address)).filter((u) => u.lovelace === 50_000_000n);
  const tx = await build({
    from: wallet,
    inputs: [input],
    outputs: [[wallet.hex, 2_000_000n]],
    metadata: await commitment(hosted),
    signers: [wallet.keys[1].hash],
    invalidHereafter: preprodSlotAt(commitmentValidUntil(hosted.drand.round)),
    withdrawals: [[`e0${wallet.keys[1].hash}`, 0n]],
  });
  const included = await send(tx);
  return { txHash: tx.txHash, height: included.block_height };
}
const waitHeight = async (height) => {
  while ((await get('/blocks/latest')).body.height < height) await sleep(1000);
};

// Backend: migrations applied to a fresh local D1 under <run dir>, then `wrangler dev` reading this Dolos.
// The Wrangler the backend declares, run directly so that the PID stopped at the end is Wrangler's own.
const WRANGLER = `${root}apps/api/node_modules/.bin/wrangler`;
const state = `${runDir}/wrangler-state`;
const migrate = spawnSync(WRANGLER, ['d1', 'migrations', 'apply', 'giveaway', '--local', '--persist-to', state], {
  cwd: `${root}apps/api`,
  encoding: 'utf8',
  env: { ...process.env, CI: '1' },
});
report.migrations = {
  status: migrate.status,
  output: migrate.stdout.split('\n').filter((l) => /0001|✅|Migrations/.test(l)),
};
assert.equal(migrate.status, 0, migrate.stderr);
const devLog = createWriteStream(`${runDir}/wrangler-dev.log`);
const dev = spawn(
  WRANGLER,
  ['dev', '--ip', '127.0.0.1', '--port', String(API_PORT), '--persist-to', state, '--var', `INDEXER_URL:${BASE}`],
  { cwd: `${root}apps/api`, stdio: ['ignore', 'pipe', 'pipe'] },
);
dev.stdout.pipe(devLog);
dev.stderr.pipe(devLog);
report.wranglerPid = dev.pid;
const call = async (method, txHash, body) => {
  const response = await fetch(`${API}/bundles/${txHash}`, { method, body, headers: { Origin: PAGE } });
  const text = await response.text();
  return {
    status: response.status,
    cors: response.headers.get('access-control-allow-origin'),
    bundleHash: response.headers.get('x-bundle-hash'),
    body: text.length > 300 ? `${text.slice(0, 300)}…` : text,
    full: text,
  };
};
const shown = ({ full, ...rest }) => rest;
let failure;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${API}/`)).status === 404) break;
    } catch {}
    if (i > 120) throw new Error('wrangler dev did not start');
    await sleep(500);
  }
  log('commitments');
  const target = await commit(WALLETS.organizer);
  report.target = target;
  // Included, not yet 15 blocks deep: refused, retry later.
  const early = await call('PUT', target.txHash, bytes);
  report.checks.beforeConfirmations = shown(early);
  assert.equal(early.status, 409);
  assert.match(early.full, /not confirmed yet/);
  await waitHeight(target.height + 14);
  const put = await call('PUT', target.txHash, bytes);
  report.checks.hosted = shown(put);
  assert.equal(put.status, 201, put.full);
  assert.equal(put.cors, PAGE);
  const hostedBody = JSON.parse(put.full);
  assert.equal(hostedBody.owner, identityOf(WALLETS.organizer.address).key);
  assert.equal(hostedBody.bundleHash, await computeCommitment(hosted));
  const served = await call('GET', target.txHash);
  report.checks.served = { ...shown(served), body: undefined, equal: served.full === bytes };
  assert.equal(served.status, 200);
  assert.equal(served.full, bytes);
  const other = canonicalize(bundle('hosting-live-other'));
  const mismatch = await call('PUT', target.txHash, other);
  report.checks.hashMismatch = shown(mismatch);
  // Same transaction already hosted: refused before any chain read.
  assert.equal(mismatch.status, 409);
  const unknown = await call('PUT', 'cd'.repeat(32), bytes);
  report.checks.unknownTransaction = shown(unknown);
  assert.equal(unknown.status, 404);
  const second = await commit(WALLETS.other);
  await waitHeight(second.height + 14);
  // Not yet hosted, so the mismatch is decided by the chain read of the commitment.
  const notThis = await call('PUT', second.txHash, other);
  report.checks.hashMismatchFromChain = shown(notThis);
  assert.equal(notThis.status, 409);
  const secondPut = await call('PUT', second.txHash, bytes);
  report.checks.sameBytesOtherIdentity = shown(secondPut);
  assert.equal(secondPut.status, 201);
  assert.equal(JSON.parse(secondPut.full).owner, identityOf(WALLETS.other.address).key);
  // The CLI's bundle mode on the bytes the backend served, against the same chain, without the backend.
  const file = `${runDir}/hosting-live.bundle.json`;
  await writeFile(file, served.full);
  const cli = spawnSync(
    process.execPath,
    [`${root}apps/verifier-cli/index.mjs`, file, '--tx', target.txHash, '--indexer', BASE],
    { encoding: 'utf8' },
  );
  const verdict = JSON.parse(cli.stdout || '{}');
  report.checks.cliBundleMode = {
    exit: cli.status,
    status: verdict.status,
    failed: (verdict.checks ?? []).filter((c) => c.result !== 'pass').map((c) => `${c.name}: ${c.detail}`),
    stderr: cli.stderr.slice(0, 300),
  };
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(verdict.status, 'PASS');
} catch (e) {
  failure = e;
} finally {
  dev.kill('SIGTERM');
  await new Promise((resolve) => dev.once('exit', resolve));
}
report.result = failure ? `FAIL: ${failure.message}` : 'all expectations met';
console.log(JSON.stringify(report, null, 2));
if (failure) process.exitCode = 1;
