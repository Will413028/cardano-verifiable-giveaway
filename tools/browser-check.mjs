import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ALGORITHM,
  canonicalize,
  commitmentMetadata,
  commitmentValidUntil,
  computeCommitment,
  encodeBech32,
  FIXTURE,
  identityKeyHash,
  LABEL,
  draftOperationText,
  parseOwnerOperation,
  preprodSlotAt,
  QUICKNET,
  roundTime,
  selectWinners,
  sha256,
  transactionHash,
  VERSION,
  verifyDataSignature,
} from '@giveaway/verifier-cli/library';
import { ACCOUNT, ANSWERS, blockfrostIndexer } from '../tests/blockfrost-mock.mjs';
import { buildTransaction, cbor, hex, sign, signData, Tag, testKey, unhex } from '../tests/cardano.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
// Same PORT variable as tools/serve.mjs, so a check can run beside another dev server.
const origin = `http://127.0.0.1:${process.env.PORT ?? 4320}/`;
// The project indexer the page was built against (tools/build.mjs GIVEAWAY_INDEXER_URL); every read is mocked here.
const INDEXER = (process.env.GIVEAWAY_INDEXER_URL ?? 'http://127.0.0.1:3010').replace(/\/$/, '');
// The backend the page was built against (tools/build.mjs GIVEAWAY_API_URL); mocked where it is used.
const API = (process.env.GIVEAWAY_API_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const { chromium } = await import(process.env.GIVEAWAY_PLAYWRIGHT_MODULE);
const browser = await chromium.launch({
  executablePath: process.env.GIVEAWAY_CHROME_PATH,
  headless: true,
  timeout: 60000,
});
const report = { browser: browser.version(), tests: [] };
const passed = (name) => {
  report.tests.push(name);
  console.log(`PASS ${name}`);
};
try {
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('No wallet needed'));
  await page
    .locator('#entrants')
    .fill('label,email\nalice,private@example.com\nbob,other@example.com\ncarol,secret@example.com');
  await page.click('#prepare');
  await page.waitForSelector('#commit');
  assert.equal(await page.locator('#preview-count').textContent(), '3');
  await page.click('#commit');
  await page.waitForSelector('#confirm');
  assert.equal(await page.locator('#winner-result').isVisible(), false);
  const pending = await page.locator('#share-link').inputValue();
  assert.ok(pending.includes('#proof='));
  await page.click('#confirm');
  await page.waitForSelector('#open');
  await page.click('#open');
  await page.waitForFunction(() => document.querySelector('#verification').textContent === 'DEMO PASS');
  assert.equal(await page.locator('#winners li').count(), 1);
  passed('create, commit, confirm, reveal without wallet');
  const link = await page.locator('#share-link').inputValue();
  const independent = await browser.newPage();
  await independent.goto(link);
  await independent.waitForFunction(() => document.querySelector('#verification').textContent === 'DEMO PASS');
  assert.equal(await independent.locator('#checks li').count(), 7);
  assert.match(await independent.locator('#evidence-source').textContent(), /simulated \(demo\)/);
  assert.equal(await independent.locator('#verified-winners li').count(), 1);
  await independent.locator('#lookup').fill('alice');
  assert.match(await independent.locator('#lookup-result').textContent(), /is in this bundle/);
  await independent.locator('#lookup').fill('not-in-list');
  assert.match(await independent.locator('#lookup-result').textContent(), /not in this bundle/);
  passed('fresh page independently verifies shared result');
  // Two downloads (plan step 10): the proof, and the canonical bundle bytes the commitment hashes.
  const fetchDownload = async (selector) => {
    const event = page.waitForEvent('download');
    await page.click(selector);
    const download = await event;
    return { path: await download.path(), name: download.suggestedFilename() };
  };
  const proofFile = await fetchDownload('#download');
  const path = proofFile.path;
  const artifact = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(proofFile.name, `${artifact.bundle.drawId}.proof.json`);
  assert.deepEqual(artifact.bundle.entrants, ['alice', 'bob', 'carol']);
  assert.equal(JSON.stringify(artifact).includes('example.com'), false);
  // --indexer is always required; a demo proof never reads it.
  const cli = spawnSync(
    process.execPath,
    [`${root}apps/verifier-cli/index.mjs`, path, '--indexer', 'https://indexer.invalid'],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'DEMO PASS');
  passed('downloaded public bundle strips contacts and independently passes CLI');
  const bundleFile = await fetchDownload('#download-bundle');
  assert.equal(bundleFile.name, `${artifact.bundle.drawId}.bundle.json`);
  const bundleText = await readFile(bundleFile.path, 'utf8');
  const bundleHash = await computeCommitment(artifact.bundle);
  // The bytes are the canonical bundle: their SHA-256 is the committed bundle hash.
  assert.equal(bundleText, canonicalize(artifact.bundle));
  assert.equal(await sha256(bundleText), bundleHash);
  const bundleCli = spawnSync(
    process.execPath,
    [
      `${root}apps/verifier-cli/index.mjs`,
      bundleFile.path,
      '--tx',
      artifact.txHash,
      '--indexer',
      'https://indexer.invalid',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(bundleCli.status, 0, bundleCli.stderr);
  assert.equal(JSON.parse(bundleCli.stdout).status, 'DEMO PASS');
  passed('downloaded canonical bundle file hashes to the commitment and passes the CLI bundle mode (--tx)');
  artifact.winners = ['mallory'];
  await independent.locator('#proof-file').setInputFiles({
    name: 'tampered.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await independent.waitForFunction(() => document.querySelector('#verification').textContent === 'FAIL');
  passed('tampered winner rejected in browser verifier');
  assert.equal(await independent.locator('#verified-result').isVisible(), false);
  // The new verification link (BR-10, F9): commitment txHash + bundle hash, here with the bundle bytes hosted at another
  // URL (`source`), since a demo draw has no on-chain commitment the backend would host.
  const BUNDLE_URL = 'https://fixture.invalid/draw.bundle.json';
  await independent.route(BUNDLE_URL, (route) =>
    route.fulfill({
      body: bundleText,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
    }),
  );
  await independent.locator('#bundle-tx').fill(artifact.txHash);
  await independent.locator('#bundle-url').fill(BUNDLE_URL);
  await independent.click('#load-url');
  await independent.waitForFunction(() => document.querySelector('#verification').textContent === 'DEMO PASS');
  const hostedLink = new URL(await independent.locator('#share-link').inputValue());
  assert.deepEqual(Object.fromEntries(hostedLink.searchParams), {
    tx: artifact.txHash,
    bundle: bundleHash,
    source: BUNDLE_URL,
  });
  assert.equal(hostedLink.hash, '');
  const fresh = await browser.newPage();
  fresh.on('pageerror', (e) => errors.push(e.message));
  await fresh.route(BUNDLE_URL, (route) =>
    route.fulfill({
      body: bundleText,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
    }),
  );
  await fresh.goto(hostedLink.toString());
  await fresh.waitForFunction(() => document.querySelector('#verification').textContent === 'DEMO PASS');
  assert.equal(await fresh.locator('#checks li').count(), 7);
  assert.deepEqual(await fresh.locator('#verified-winners li').allTextContents(), JSON.parse(cli.stdout).winners);
  passed('new link format (txHash + bundle hash) completes DEMO PASS on a fresh page');
  const changed = new URL(hostedLink);
  changed.searchParams.set('bundle', '0'.repeat(64));
  await fresh.goto(changed.toString());
  await fresh.waitForFunction(() =>
    document.querySelector('#verification').textContent.includes('hash does not match'),
  );
  // The former hosted-proof link (a proof file URL and that file's hash) is refused with an explicit error.
  const former = new URL(origin);
  former.search = new URLSearchParams({
    bundle: 'https://fixture.invalid/proof.json',
    hash: '0'.repeat(64),
  }).toString();
  await fresh.goto(former.toString());
  await fresh.waitForFunction(() =>
    document.querySelector('#verification').textContent.includes('former hosted-proof'),
  );
  // A current-format link with a missing or malformed field is named as such, not as the former format.
  for (const [drop, set, message] of [
    ['tx', null, 'has no commitment transaction (tx)'],
    [null, ['tx', 'not-a-hash'], 'The commitment transaction (tx) in this link is not a 64-character hex hash'],
    [null, ['bundle', 'ab'], 'The bundle hash (bundle) in this link is missing or not a 64-character hex hash'],
  ]) {
    const broken = new URL(hostedLink);
    if (drop) broken.searchParams.delete(drop);
    if (set) broken.searchParams.set(...set);
    await fresh.goto(broken.toString());
    await fresh.waitForFunction(
      (expected) => document.querySelector('#verification').textContent.includes(expected),
      message,
    );
    assert.equal((await fresh.locator('#verification').textContent()).includes('former hosted-proof'), false);
  }
  await fresh.close();
  passed('link pins the bundle hash; changed content, the former link format and broken links are refused');
  await page.click('#prepare');
  await page.waitForSelector('#commit');
  await page.click('#commit');
  await page.waitForSelector('#late');
  await page.click('#late');
  await page.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('invalid'));
  assert.equal(await page.locator('#open').isVisible(), false);
  passed('late confirmation prevents opening');
  await page.selectOption('#network', 'preprod');
  await page.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('No CIP-30'));
  assert.equal(await page.locator('#wallet option').count(), 0);
  passed('preprod without installed wallet gives actionable status');
  const mainnet = await browser.newPage();
  await mainnet.addInitScript(() => {
    window.cardano = {
      mock: { name: 'Mock mainnet', icon: '', apiVersion: '1', enable: async () => ({ getNetworkId: async () => 1 }) },
    };
  });
  await mainnet.goto(origin);
  await mainnet.selectOption('#network', 'preprod');
  await mainnet.waitForSelector('#wallet option', { state: 'attached' });
  await mainnet.click('#prepare');
  await mainnet.waitForFunction(() =>
    document.querySelector('#draw-status').textContent.includes('Mainnet is disabled'),
  );
  assert.equal(await mainnet.locator('#commit').isVisible(), false);
  await mainnet.close();
  passed('mock mainnet wallet cannot build or submit');
  // Two wallets: an enterprise address, which the page refuses as organizer (PD10), and a base address whose test keys
  // (tests/cardano.mjs, seeds 1 and 2) sign in Node through an exposed function, so the page gets real vkey witnesses.
  const payment = testKey(1);
  const stake = testKey(2);
  const wallets = {
    enterprise: `60${'00'.repeat(28)}`,
    base: `00${payment.hash}${stake.hash}`,
  };
  const bech32 = (hex) => encodeBech32('addr_test', unhex(hex));
  const STAKE = encodeBech32('stake_test', unhex(`e0${stake.hash}`));
  // CIP-30 UTxO CBOR: [[tx id, index 0], [address, 10 ADA]].
  const utxoOf = (addressHex) =>
    `82825820${'00'.repeat(32)}0082${addressHex.length === 58 ? '581d' : '5839'}${addressHex}1a00989680`;
  // The witness set a CIP-30 wallet returns from signTx: both keys sign the transaction id.
  const witnessSet = (unsigned) => {
    const txId = unhex(transactionHash(unsigned));
    return hex(
      cbor(
        new Map([
          [
            0,
            new Tag(
              258,
              [payment, stake].map((k) => [k.publicKey, sign(k, txId)]),
            ),
          ],
        ]),
      ),
    );
  };
  // Blockfrost-shaped mock of the project indexer shared by the preprod pages (tests/blockfrost-mock.mjs, answers
  // copied from Dolos 1.6.1 and, for /tx/submit, from the reverse proxy in front of it). The wallet's UTxO is output 0
  // of transaction 00…00, which the indexer reports under `utxoHash` (default the same id). A transaction the wallet
  // submitted (`submitted`, filled by the mock wallet's submitTx) is not indexed (/txs/{h} answers 404) unless
  // `onRead` indexes it; `onRead(route, url, ctx)` may answer a read itself and returns true when it did. The base
  // wallet's stake account answers as recorded after registration and DRep delegation, with `account`'s fields
  // replacing those; `account: null` makes it a stake credential the node never saw (404). Every request that reaches
  // the indexer is in `indexer.calls`.
  const routePreprod = async (
    target,
    addressHex,
    submitted,
    { utxoHash = '00'.repeat(32), onRead, account = {} } = {},
  ) => {
    const txs = [];
    const funding = `/txs/${'00'.repeat(32)}/utxos`;
    const indexer = blockfrostIndexer({
      txs,
      accounts: account === null ? {} : { [STAKE]: account },
      fault: (path) =>
        path === funding
          ? ANSWERS.json(200, {
              hash: utxoHash,
              inputs: [],
              outputs: [
                {
                  address: bech32(addressHex),
                  amount: [{ unit: 'lovelace', quantity: '10000000' }],
                  output_index: 0,
                  data_hash: null,
                  inline_datum: null,
                  collateral: false,
                  reference_script_hash: null,
                  consumed_by_tx: null,
                },
              ],
            })
          : undefined,
    });
    // Indexes a submitted transaction in block `height` at `time`, spending from the wallet's address.
    const index = (txHash, height, time) => {
      if (!txs.some((t) => t.txHash === txHash))
        txs.push({
          txHash,
          cbor: submitted.get(txHash),
          blockHeight: height,
          blockTime: time,
          inputs: [bech32(addressHex)],
        });
    };
    await target.route(`${INDEXER}/**`, async (route) => {
      const request = route.request();
      if (onRead && (await onRead(route, request.url(), { submitted, index }))) return;
      const answer = indexer.answer(request.method(), request.url());
      await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
    });
    return indexer;
  };
  // CIP-30 signData as a wallet holding the base wallet's keys answers it: the stake key for its reward address, the
  // payment key for the base address (plan step 11; owner operations must use the stake key).
  const REWARD = `e0${stake.hash}`;
  const signDataFor = (address, payload) => {
    const key = address === REWARD ? stake : address === wallets.base ? payment : null;
    if (!key) throw new Error('The mock wallet holds no key for this address');
    return signData(key, unhex(address), unhex(payload));
  };
  // A CIP-30 mock. With `sign` it approves through the exposed `mockSign`; every signTx call is counted. submitTx
  // hands the signed transaction to the exposed `mockSubmit` (the wallet's own infrastructure, not the project
  // indexer) and answers its id; every call is counted. signData (owner operations) records the address asked for and
  // signs through the exposed `mockSignData`.
  const mockWallet = ({ utxo, address, sign }) => {
    window.signCalls = 0;
    window.submitCalls = 0;
    window.signDataCalls = [];
    window.cardano = {
      mock: {
        name: 'Mock preprod',
        icon: '',
        apiVersion: '1',
        enable: async () => ({
          getNetworkId: async () => 0,
          getChangeAddress: async () => address,
          getUtxos: async () => [utxo],
          signTx: async (tx) => {
            window.signCalls++;
            if (sign) return window.mockSign(tx);
            throw new Error('No signing allowed in automated browser checks');
          },
          submitTx: async (tx) => {
            window.submitCalls++;
            return window.mockSubmit(tx);
          },
          signData: async (addr, payload) => {
            window.signDataCalls.push(addr);
            if (sign) return window.mockSignData(addr, payload);
            throw new Error('No signing allowed in automated browser checks');
          },
        }),
      },
    };
  };
  const preprodPage = async ({ wallet = 'base', sign = false, clock = false, ...route } = {}) => {
    const target = await browser.newPage();
    const pageErrors = [];
    target.on('pageerror', (e) => pageErrors.push(e.message));
    if (clock) await target.clock.install();
    await target.exposeFunction('mockSign', witnessSet);
    await target.exposeFunction('mockSignData', signDataFor);
    const submitted = new Map();
    await target.exposeFunction('mockSubmit', (tx) => {
      submitted.set(transactionHash(tx), tx);
      return transactionHash(tx);
    });
    const indexer = await routePreprod(target, wallets[wallet], submitted, route);
    await target.addInitScript(mockWallet, { utxo: utxoOf(wallets[wallet]), address: wallets[wallet], sign });
    await target.goto(origin);
    await target.selectOption('#network', 'preprod');
    await target.waitForSelector('#wallet option', { state: 'attached' });
    return { target, pageErrors, indexer, submitted };
  };
  const statusText = (target) => target.locator('#draw-status').textContent();
  {
    const { target } = await preprodPage();
    await target.click('#prepare');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Ready to sign'));
    assert.match(await statusText(target), /Estimated fee/);
    assert.equal(await target.locator('#commit').textContent(), 'Sign and submit to preprod');
    await target.close();
  }
  passed('mock preprod wallet builds unsigned commitment and displays fee');
  // PD10: an enterprise address has no reward account, so it cannot be an organizer; the page says why and builds nothing.
  {
    const { target, indexer } = await preprodPage({ wallet: 'enterprise' });
    await target.click('#prepare');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('base address'));
    assert.match(
      await statusText(target),
      /must be a base address with a stake key.*enterprise address has no reward account/,
    );
    assert.equal(await target.locator('#commit').isVisible(), false);
    assert.equal(await target.evaluate(() => window.signCalls), 0);
    assert.ok(!indexer.calls.some((c) => c.startsWith('/accounts/')));
    await target.close();
  }
  passed('enterprise organizer address is refused on the creation page with the reason');
  // PD10: the stake key must be registered and delegated to a DRep in an earlier transaction; the page explains that
  // instead of building a commitment the ledger would refuse.
  for (const [name, account, expected] of [
    ['never seen on chain (404)', null, /is not registered/],
    ['not registered', { ...ACCOUNT.unregistered, stake_address: STAKE }, /is not registered/],
    ['registered, no DRep', { registered: true, drep_id: null }, /is not delegated to a DRep/],
  ]) {
    const { target, indexer } = await preprodPage({ account });
    await target.click('#prepare');
    await target.waitForFunction(() => /registered|DRep/.test(document.querySelector('#draw-status').textContent));
    const text = await statusText(target);
    assert.match(text, expected, name);
    assert.match(text, /separate transaction/, name);
    assert.equal(await target.locator('#commit').isVisible(), false, name);
    assert.equal(await target.evaluate(() => window.signCalls), 0, name);
    assert.ok(indexer.calls.includes(`/accounts/${STAKE}`), name);
    await target.close();
  }
  passed('unregistered or undelegated stake key gets the setup explanation, nothing to sign');
  // The indexer reports the wallet's UTxO under another transaction id (Evolution takes the id from the answer body);
  // the SDK builds a transaction spending that output, and the re-read of the unsigned CBOR must stop it before the
  // wallet is asked to sign.
  {
    const { target } = await preprodPage({ utxoHash: '11'.repeat(32) });
    await target.click('#prepare');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('unexpected input'));
    assert.equal(await target.locator('#commit').isVisible(), false);
    assert.equal(await target.evaluate(() => window.signCalls), 0);
    await target.close();
  }
  passed('unsigned transaction that differs from the plan is never signed');
  // The confirmation poll waits on the indexer while the draw is reset; the late answer must not reach the page.
  // `indexed` covers the success path (the commitment is found and confirmed) and the error path (not yet indexed).
  for (const indexed of [false, true]) {
    let release, polled;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const pollSeen = new Promise((resolve) => {
      polled = resolve;
    });
    const included = Math.floor(Date.now() / 1000);
    const {
      target: stale,
      pageErrors: staleErrors,
      indexer: staleIndexer,
      submitted,
    } = await preprodPage({
      wallet: 'base',
      sign: true,
      clock: true,
      // The poll's first read (/txs/{h}) is held until the draw has been reset; indexed, the rest of the read
      // (CBOR, inputs, tip, 15th block) follows from the mock.
      onRead: async (_route, url, { index }) => {
        const txHash = url.match(/\/txs\/([a-f0-9]{64})$/)?.[1];
        if (!txHash) return false;
        polled();
        await held;
        if (indexed) index(txHash, 100, included);
        return false;
      },
    });
    await stale.click('#prepare');
    await stale.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Ready to sign'));
    await stale.click('#commit');
    await stale.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Submitted'));
    assert.equal(await stale.evaluate(() => window.signCalls), 1);
    // BR-15, F14: the wallet submitted the signed transaction; nothing was posted to the project indexer.
    assert.equal(await stale.evaluate(() => window.submitCalls), 1);
    assert.equal(submitted.size, 1);
    assert.deepEqual(
      staleIndexer.calls.filter((c) => c.startsWith('/tx/')),
      [],
    );
    await stale.clock.fastForward(31000);
    await pollSeen;
    await stale.selectOption('#network', 'demo');
    const statusAfterReset = await statusText(stale);
    // The last request of each path: the 15th block when indexed, the transaction read otherwise.
    const lastRead = stale.waitForResponse((r) =>
      indexed ? r.url().endsWith(`/blocks/${100 + 14}`) : /\/txs\/[a-f0-9]{64}$/.test(r.url()),
    );
    release();
    await lastRead;
    await stale.waitForTimeout(500);
    assert.equal(await statusText(stale), statusAfterReset);
    assert.equal(await stale.locator('#open').isVisible(), false);
    assert.deepEqual(staleErrors, []);
    await stale.close();
  }
  passed('confirmation response after a reset is discarded');
  passed('the wallet submits the signed commitment (CIP-30 submitTx); the indexer receives no submission');
  // Hosting (plan steps 10, 11): after 15 confirmations the organizer asks the backend to host the canonical bundle
  // bytes (PUT /bundles/{txHash}), signed with signData by the organizer's stake key for its reward address; the share
  // link becomes txHash + bundle hash. The backend is mocked here (its gate, signature checks and retention are tested
  // in apps/api against D1, R2 and the chain); the page must send exactly the committed bytes and a signature over the
  // owner operation text for this page, the operation, the commitment and its bundle hash, which this mock checks
  // with the trust-path verifier. Twice: hosted past the round, then deleted (the link falls back and the page says to
  // keep the downloaded files, BR-13); and hosted only until before it (a round more than 12 months after the first
  // hosting, ADR Amendment 5), where the page must not promise that the link shows the winners, then extended past
  // the round (BR-17), when the hosted link is offered.
  for (const pastRound of [true, false]) {
    const { target, pageErrors, submitted } = await preprodPage({
      sign: true,
      onRead: async (_route, url, { index }) => {
        const txHash = url.match(/\/txs\/([a-f0-9]{64})$/)?.[1];
        if (txHash) index(txHash, 100, Math.floor(Date.now() / 1000) - 60);
        return false;
      },
    });
    const calls = [];
    const hostedUntil = pastRound ? 1_900_000_000 : Math.floor(Date.now() / 1000) + 60;
    const page = new URL(origin);
    // The operation the request's Authorization header signs, checked as the backend checks it (apps/api/src/auth.ts).
    const signedOperation = (request) => {
      const [, signature, key] = (request.headers().authorization ?? '').split(' ');
      const verified = verifyDataSignature({ signature, key });
      assert.ok(verified, 'the owner signature verifies');
      assert.equal(hex(verified.address), REWARD);
      assert.equal(verified.keyHash, stake.hash);
      const op = parseOwnerOperation(new TextDecoder().decode(verified.payload));
      assert.equal(op.domain, page.host);
      assert.equal(op.network, 'preprod');
      return op;
    };
    await target.route(`${API}/**`, async (route) => {
      const request = route.request();
      const cors = { 'Access-Control-Allow-Origin': page.origin, Vary: 'Origin' };
      if (request.method() === 'OPTIONS')
        return route.fulfill({
          status: 204,
          headers: {
            ...cors,
            'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          },
        });
      const url = new URL(request.url());
      if (url.pathname === '/nonce') {
        const issuedAt = Math.floor(Date.now() / 1000);
        return route.fulfill({
          status: 200,
          headers: cors,
          json: { nonce: hex(crypto.getRandomValues(new Uint8Array(16))), issuedAt, expiresAt: issuedAt + 300 },
        });
      }
      const op = signedOperation(request);
      calls.push({ method: request.method(), path: url.pathname, op, body: request.postDataBuffer() });
      if (request.method() === 'PUT')
        return route.fulfill({ status: 201, headers: cors, json: { expiresAt: hostedUntil } });
      if (request.method() === 'POST')
        return route.fulfill({ status: 200, headers: cors, json: { expiresAt: 1_900_000_000, extensionsLeft: 1 } });
      return route.fulfill({ status: 200, headers: cors, json: { deleted: true } });
    });
    await target.click('#prepare');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Ready to sign'));
    const committedHash = await target.locator('#preview-hash').textContent();
    await target.click('#commit');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Submitted'));
    assert.equal(await target.locator('#host').isVisible(), false);
    await target.click('#confirm');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Fifteen'));
    for (const id of ['#extend-hosting', '#delete-hosted']) assert.equal(await target.locator(id).isVisible(), false);
    await target.click('#host');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Bundle hosted'));
    const [txHash] = [...submitted.keys()];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].path, `/bundles/${txHash}`);
    assert.equal(await sha256(new Uint8Array(calls[0].body)), committedHash);
    assert.deepEqual(
      [calls[0].op.operation, calls[0].op.txHash, calls[0].op.bundleHash],
      ['host', txHash, committedHash],
    );
    // The wallet was asked to sign for the organizer's reward address (the stake key), not for its payment address.
    assert.deepEqual(await target.evaluate(() => window.signDataCalls), [REWARD]);
    const link = new URL(await target.locator('#share-link').inputValue());
    if (pastRound) assert.deepEqual(Object.fromEntries(link.searchParams), { tx: txHash, bundle: committedHash });
    // A hosted link that dies before the round is not offered: the inline announcement link stays.
    else assert.ok(!link.searchParams.has('tx') && link.hash.startsWith('#proof='), link.href);
    assert.equal(await target.locator('#host').isVisible(), false);
    for (const id of ['#extend-hosting', '#delete-hosted']) assert.equal(await target.locator(id).isVisible(), true);
    const status = await target.locator('#draw-status').textContent();
    const note = await target.locator('#result-note').textContent();
    if (pastRound) {
      assert.match(status, /shows the winners once the round arrives/);
      assert.match(note, /hosted until .*shows the winners once the round arrives/);
      // Deletion: signed, the hosted link is withdrawn, and the page says to keep the downloaded files (BR-13).
      await target.click('#delete-hosted');
      await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('deleted'));
      assert.deepEqual(
        [calls[1].method, calls[1].path, calls[1].op.operation, calls[1].op.bundleHash],
        ['DELETE', `/bundles/${txHash}`, 'delete', committedHash],
      );
      assert.match(
        await statusText(target),
        /hosted verification link no longer works\. Keep the downloaded bundle file and proof/,
      );
      const after = new URL(await target.locator('#share-link').inputValue());
      assert.ok(!after.searchParams.has('tx') && after.hash.startsWith('#proof='), after.href);
      for (const id of ['#extend-hosting', '#delete-hosted']) assert.equal(await target.locator(id).isVisible(), false);
      assert.equal(await target.locator('#host').isVisible(), true);
      assert.equal(await target.locator('#download-bundle').isVisible(), true);
    } else {
      for (const text of [status, note]) {
        assert.match(text, /hosted only until .*before the round .*stop working then, so it is not offered.*source/);
        assert.doesNotMatch(text, /shows the winners/);
      }
      // Extension: signed, and once the hosting outlasts the round the hosted link is offered (BR-17).
      await target.click('#extend-hosting');
      await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('extended'));
      assert.deepEqual(
        [calls[1].method, calls[1].path, calls[1].op.operation, calls[1].op.bundleHash],
        ['POST', `/bundles/${txHash}/extend`, 'extend', committedHash],
      );
      assert.notEqual(calls[1].op.nonce, calls[0].op.nonce);
      assert.match(await statusText(target), /Hosting extended\. .*shows the winners once the round arrives/);
      const extended = new URL(await target.locator('#share-link').inputValue());
      assert.deepEqual(Object.fromEntries(extended.searchParams), { tx: txHash, bundle: committedHash });
      assert.equal(await target.locator('#extend-hosting').isVisible(), true);
    }
    assert.equal(calls.length, 2);
    assert.deepEqual(pageErrors, []);
    await target.close();
  }
  passed(
    'a confirmed preprod commitment is hosted with its committed bytes under the organizer stake key signature and shared as txHash + bundle hash; the page says whether the hosting outlasts the round, extends it and deletes it with signed requests',
  );
  // A signed commitment the indexer never sees: once its invalid_hereafter has passed, the page says it expired
  // and asks for a later round instead of waiting for the round.
  {
    const { target, pageErrors } = await preprodPage({ wallet: 'base', sign: true, clock: true });
    await target.click('#prepare');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Ready to sign'));
    await target.click('#commit');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Submitted'));
    const round = Number(await target.locator('#round').inputValue());
    const validUntil = commitmentValidUntil(round);
    assert.ok(validUntil < roundTime(round));
    // The first poll before the bound keeps waiting; the first one after it reports the expiry.
    await target.clock.fastForward(31000);
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Next check'));
    const seconds = Math.ceil(validUntil - (await target.evaluate(() => Date.now() / 1000)));
    await target.clock.fastForward((seconds + 31) * 1000);
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('expired'));
    assert.match(await statusText(target), /later round/);
    assert.equal(await target.locator('#open').isVisible(), false);
    assert.deepEqual(pageErrors, []);
    await target.close();
  }
  passed('expired commitment asks for a later round');
  // The indexer lists the transaction but serves no CBOR yet: the transaction may be on chain, so even past its
  // invalid_hereafter the page keeps polling and never advises a resubmission (which would overlap the original).
  {
    let polls = 0;
    const { target, pageErrors } = await preprodPage({
      wallet: 'base',
      sign: true,
      clock: true,
      // /txs/{h} answers (indexed in block 100); /txs/{h}/cbor answers 404, as for an unknown transaction.
      onRead: async (route, url, { index }) => {
        const [, txHash, part] = url.match(/\/txs\/([a-f0-9]{64})(\/cbor)?$/) ?? [];
        if (!txHash || txHash === '00'.repeat(32)) return false;
        if (!part) {
          polls++;
          index(txHash, 100, Math.floor(Date.now() / 1000));
          return false;
        }
        const answer = ANSWERS.unknownTransaction();
        await route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
        return true;
      },
    });
    await target.click('#prepare');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Ready to sign'));
    await target.click('#commit');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Submitted'));
    const round = Number(await target.locator('#round').inputValue());
    const validUntil = commitmentValidUntil(round);
    const seconds = Math.ceil(validUntil - (await target.evaluate(() => Date.now() / 1000)));
    await target.clock.fastForward((seconds + 31) * 1000);
    await target.waitForFunction(() => /Next check|expired/.test(document.querySelector('#draw-status').textContent));
    assert.doesNotMatch(await statusText(target), /expired|later round/);
    const before = polls;
    await target.clock.fastForward(31000);
    await target.waitForTimeout(500);
    assert.ok(polls > before, 'polling continues past invalid_hereafter');
    assert.doesNotMatch(await statusText(target), /expired|later round/);
    assert.match(await statusText(target), /has not served/);
    assert.equal(await target.locator('#open').isVisible(), false);
    assert.deepEqual(pageErrors, []);
    await target.close();
  }
  passed('indexed transaction without CBOR keeps polling past invalid_hereafter');
  // The verification page reads chain evidence from the indexer the visitor names, and from nowhere else (BR-16).
  // A preprod commitment signed with the test keys is served only by that indexer's mock.
  {
    const own = 'https://indexer.example.test';
    const b = {
      version: VERSION,
      algorithm: ALGORITHM,
      drawId: 'own-indexer',
      entrants: ['alice', 'bob'],
      rules: { winners: 1 },
      drand: { chainHash: QUICKNET, round: FIXTURE.round },
    };
    const owner = bech32(wallets.base);
    const metadata = commitmentMetadata(b, await computeCommitment(b));
    const tx = buildTransaction({
      label: LABEL,
      metadata,
      signers: [identityKeyHash(owner)],
      witnesses: [payment, stake],
      withdrawals: [[`e0${stake.hash}`, 0n]],
      invalidHereafter: preprodSlotAt(commitmentValidUntil(FIXTURE.round)),
      address: wallets.base,
    });
    const record = {
      ...tx,
      label: LABEL,
      metadata,
      inputs: [owner],
      blockHeight: 1000,
      blockTime: roundTime(FIXTURE.round) - 900,
    };
    const result = {
      format: 'giveaway-proof-2',
      network: 'preprod',
      bundle: b,
      txHash: tx.txHash,
      owner,
      beacon: FIXTURE,
      winners: await selectWinners(b, FIXTURE.randomness),
    };
    const verifier = await browser.newPage();
    const ownMock = blockfrostIndexer({ txs: [record] });
    const projectMock = blockfrostIndexer({ txs: [] });
    const hosts = [];
    verifier.on('request', (r) => hosts.push(new URL(r.url()).origin));
    for (const [base, mock] of [
      [own, ownMock],
      [INDEXER, projectMock],
    ])
      await verifier.route(`${base}/**`, (route) => {
        const answer = mock.answer(route.request().method(), route.request().url());
        return route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
      });
    await verifier.goto(origin);
    const load = async () => {
      hosts.length = 0;
      await verifier.locator('#proof-file').setInputFiles({
        name: 'preprod.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(result)),
      });
      await verifier.waitForFunction(() => /PASS|FAIL/.test(document.querySelector('#verification').textContent));
      return verifier.locator('#verification').textContent();
    };
    await verifier.locator('#indexer').fill(own);
    assert.equal(await load(), 'PASS');
    // BR-16: the page names the indexer the evidence came from.
    assert.equal(
      await verifier.locator('#evidence-source').textContent(),
      `Chain evidence source: ${own} (the indexer you named). The result depends on what this indexer reports.`,
    );
    // The requests of one full verification, counted by the mock (plan step 9, for the reverse proxy's rate limit):
    // reading the commitment 5 (/txs/{h}, /cbor, /utxos, /blocks/latest, /blocks/{h+14}), the account's withdrawal list
    // 1 page, metadata of the n = 1 listed transaction, CBOR of the k = 1 label match.
    report.verificationRequests = [...ownMock.calls];
    assert.equal(ownMock.calls.length, 5 + 1 + 1 + 1, JSON.stringify(ownMock.calls));
    const indexerHosts = hosts.filter((h) => h !== new URL(origin).origin);
    assert.ok(indexerHosts.length > 0 && indexerHosts.every((h) => h === own), JSON.stringify(indexerHosts));
    assert.equal(projectMock.calls.length, 0);
    assert.ok(ownMock.calls.includes(`/txs/${tx.txHash}/cbor`));
    // Emptied, the field falls back to the project indexer, which does not know this transaction.
    await verifier.locator('#indexer').fill('');
    assert.equal(await load(), 'FAIL');
    assert.match(
      await verifier.locator('#evidence-source').textContent(),
      new RegExp(`${INDEXER} \\(the project indexer\\)`),
    );
    assert.ok(projectMock.calls.includes(`/txs/${tx.txHash}`));
    // Plain http to another machine is refused before any request.
    await verifier.locator('#indexer').fill('http://indexer.example.test');
    projectMock.calls.length = 0;
    await verifier
      .locator('#proof-file')
      .setInputFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(result)) });
    await verifier.waitForFunction(() => document.querySelector('#verification').textContent.includes('https URL'));
    assert.equal(projectMock.calls.length, 0);
    await verifier.close();
  }
  passed('verification page reads only the indexer the visitor names');
  let exportedDraft = '';
  // Drafts (plan step 12; BR-11): the setup form is kept in this browser's IndexedDB as it is edited and restored on
  // the next load, mode included; it exports to a file that imports back to the same form. A draft never enters the
  // verification flow, and a verification file is not a draft.
  {
    const drafting = await browser.newPage({ acceptDownloads: true });
    const pageErrors = [];
    drafting.on('pageerror', (e) => pageErrors.push(e.message));
    await drafting.goto(origin);
    await drafting.waitForFunction(() =>
      document.querySelector('#draw-status').textContent.includes('No wallet needed'),
    );
    const note = () => drafting.locator('#draft-note').textContent();
    const form = () =>
      drafting.evaluate(() =>
        ['network', 'entrants', 'winner-count', 'round'].map((id) => document.getElementById(id).value),
      );
    await drafting.selectOption('#network', 'preprod');
    await drafting.locator('#entrants').fill('zoe\nyan\nxu\nwen');
    await drafting.locator('#winner-count').fill('2');
    await drafting.locator('#round').fill('98765432');
    await drafting.waitForFunction(() =>
      document.querySelector('#draft-note').textContent.includes('kept in this browser ('),
    );
    const kept = await form();
    assert.deepEqual(kept, ['preprod', 'zoe\nyan\nxu\nwen', '2', '98765432']);
    await drafting.reload();
    await drafting.waitForFunction(() => document.querySelector('#draft-note').textContent.startsWith('Restored'));
    assert.deepEqual(await form(), kept);
    // Restored in its mode: the preprod fields are shown and the participant count follows the restored text.
    assert.equal(await drafting.locator('#wallet-area').isVisible(), true);
    assert.equal(await drafting.locator('#entrant-count').textContent(), '4 participants');
    assert.match(await note(), /Restored the draft kept in this browser/);
    passed('a draft is kept in this browser while editing and restored with its mode after a reload');
    const exported = async () => {
      const event = drafting.waitForEvent('download');
      await drafting.click('#export-draft');
      const download = await event;
      return { name: download.suggestedFilename(), text: await readFile(await download.path(), 'utf8') };
    };
    const first = await exported();
    exportedDraft = first.text;
    assert.equal(first.name, 'open-draw-draft.json');
    assert.deepEqual(JSON.parse(first.text), {
      format: 'giveaway-draft-1',
      mode: 'preprod',
      entrants: 'zoe\nyan\nxu\nwen',
      winners: '2',
      round: '98765432',
    });
    await drafting.selectOption('#network', 'demo');
    await drafting.locator('#entrants').fill('somebody else');
    await drafting.locator('#winner-count').fill('1');
    assert.notDeepEqual(await form(), kept);
    await drafting
      .locator('#import-draft')
      .setInputFiles({ name: 'd.json', mimeType: 'application/json', buffer: Buffer.from(first.text) });
    await drafting.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Draft imported'));
    assert.deepEqual(await form(), kept);
    assert.equal((await exported()).text, first.text);
    // The import is kept like an edit: it survives a reload too.
    await drafting.waitForFunction(() =>
      document.querySelector('#draft-note').textContent.includes('kept in this browser ('),
    );
    await drafting.reload();
    await drafting.waitForFunction(() => document.querySelector('#draft-note').textContent.startsWith('Restored'));
    assert.deepEqual(await form(), kept);
    passed('an exported draft imports back to the identical form, and the export of that is the same file');
    // Regression (step 12 race, fixed in plan step 13): after a reload the preprod restore lists the wallets with the
    // controls locked; an import arriving then was dropped without a word. The wallet module is held here until the
    // import has been made, so the page is deterministically busy: the import must be queued, said so, and applied.
    {
      const chunk = /\/chunks\/cardano-[^/]+\.js$/;
      let release;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      await drafting.route(chunk, async (route) => {
        await held;
        await route.continue();
      });
      await drafting.reload();
      await drafting.waitForFunction(() => document.querySelector('#draft-note').textContent.startsWith('Restored'));
      await drafting.waitForFunction(() => document.querySelector('#import-draft').disabled);
      const queued = {
        format: 'giveaway-draft-1',
        mode: 'preprod',
        entrants: 'held\nqueued',
        winners: '1',
        round: '98765433',
      };
      await drafting
        .locator('#import-draft')
        .setInputFiles({ name: 'q.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(queued)) });
      await drafting.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('is queued'));
      release();
      await drafting.waitForFunction(() =>
        document.querySelector('#draw-status').textContent.includes('Draft imported'),
      );
      assert.deepEqual(await form(), ['preprod', 'held\nqueued', '1', '98765433']);
      await drafting.unroute(chunk);
      // Back to the kept form for the checks below.
      await drafting
        .locator('#import-draft')
        .setInputFiles({ name: 'd.json', mimeType: 'application/json', buffer: Buffer.from(first.text) });
      await drafting.waitForFunction(
        (entrants) =>
          document.querySelector('#entrants').value === entrants && !document.querySelector('#import-draft').disabled,
        kept[1],
      );
      assert.deepEqual(await form(), kept);
    }
    passed('an import made while the page is busy after a reload is queued with a message, never dropped');
    // A verification proof is not a draft, and a draft is not a verifiable artifact.
    await drafting.locator('#import-draft').setInputFiles(path);
    await drafting.waitForFunction(() =>
      document.querySelector('#draw-status').textContent.includes('not an Open Draw draft'),
    );
    assert.deepEqual(await form(), kept);
    await drafting
      .locator('#proof-file')
      .setInputFiles({ name: 'd.json', mimeType: 'application/json', buffer: Buffer.from(first.text) });
    await drafting.waitForFunction(() => document.querySelector('#verification').textContent.startsWith('FAIL'));
    assert.equal(await drafting.locator('#verified-result').isVisible(), false);
    // A committed draw is not discarded by importing a draft: the import is refused and the draw stays.
    await drafting.selectOption('#network', 'demo');
    await drafting.click('#prepare');
    await drafting.waitForSelector('#commit');
    await drafting.click('#commit');
    await drafting.waitForSelector('#confirm');
    await drafting
      .locator('#import-draft')
      .setInputFiles({ name: 'd.json', mimeType: 'application/json', buffer: Buffer.from(first.text) });
    await drafting.waitForFunction(() =>
      document.querySelector('#draw-status').textContent.includes('A committed draw is in progress'),
    );
    assert.equal(await drafting.locator('#confirm').isVisible(), true);
    assert.equal(await drafting.locator('#network').inputValue(), 'demo');
    assert.deepEqual(pageErrors, []);
    await drafting.close();
  }
  passed('a draft never enters the verification flow, and a proof file is refused as a draft');
  // A preprod draft imported on a page still in demo mode switches to preprod with the browser's wallets listed
  // (review LOW 1); and when the backend's draft storage is full (507, the global cap), the page says that the browser
  // copy and the export still work.
  {
    const target = await browser.newPage();
    const pageErrors = [];
    target.on('pageerror', (e) => pageErrors.push(e.message));
    await target.exposeFunction('mockSignData', signDataFor);
    await target.addInitScript(mockWallet, { utxo: utxoOf(wallets.base), address: wallets.base, sign: true });
    await target.route(`${INDEXER}/**`, (route) => route.fulfill({ status: 404, body: '' }));
    await target.route(`${API}/**`, async (route) => {
      const request = route.request();
      const cors = { 'Access-Control-Allow-Origin': new URL(origin).origin, Vary: 'Origin' };
      if (request.method() === 'OPTIONS')
        return route.fulfill({
          status: 204,
          headers: {
            ...cors,
            'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          },
        });
      if (new URL(request.url()).pathname === '/nonce') {
        const issuedAt = Math.floor(Date.now() / 1000);
        return route.fulfill({
          status: 200,
          headers: cors,
          json: { nonce: hex(crypto.getRandomValues(new Uint8Array(16))), issuedAt, expiresAt: issuedAt + 300 },
        });
      }
      return route.fulfill({ status: 507, headers: cors, body: 'Server draft storage is full (the global cap).' });
    });
    await target.goto(origin);
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('No wallet needed'));
    assert.equal(await target.locator('#wallet option').count(), 0);
    await target
      .locator('#import-draft')
      .setInputFiles({ name: 'd.json', mimeType: 'application/json', buffer: Buffer.from(exportedDraft) });
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Draft imported'));
    assert.equal(await target.locator('#network').inputValue(), 'preprod');
    await target.waitForSelector('#wallet option', { state: 'attached' });
    assert.equal(await target.locator('#wallet option').textContent(), 'Mock preprod');
    await target.click('#save-server-draft');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('storage is full'));
    assert.match(
      await statusText(target),
      /not saved to the server\. It is still kept in this browser, and Export draft still saves a copy/,
    );
    assert.deepEqual(pageErrors, []);
    await target.close();
  }
  passed(
    'an imported preprod draft lists the wallets; a full server draft storage (507) leaves the browser copy and export',
  );
  // Server drafts (BR-12, BR-18) against the real local backend (`make api`): every operation is signed by the
  // wallet's stake key for its reward address, only the public labels are sent, and save, list, load and delete work
  // end to end. Leftovers of an earlier run of this check (same test key) are deleted first through the same API.
  {
    const apiDraft = async (operation, draft, method, apiPath, body) => {
      const nonceResponse = await fetch(`${API}/nonce`);
      assert.equal(
        nonceResponse.status,
        200,
        `start the backend (make api): GET /nonce answered ${nonceResponse.status}`,
      );
      const { nonce, issuedAt } = await nonceResponse.json();
      const text = draftOperationText({
        domain: new URL(origin).host,
        operation,
        network: 'preprod',
        draft,
        content: 'none',
        nonce,
        issuedAt,
      });
      const signed = signDataFor(REWARD, hex(new TextEncoder().encode(text)));
      return fetch(`${API}${apiPath}`, {
        method,
        body,
        headers: { Authorization: `CIP30 ${signed.signature} ${signed.key}` },
      });
    };
    const leftovers = await (await apiDraft('draft-list', 'all', 'GET', '/drafts')).json();
    for (const { id } of leftovers.drafts)
      assert.equal((await apiDraft('draft-delete', id, 'DELETE', `/drafts/${id}`)).status, 200);
    const { target, pageErrors } = await preprodPage({ sign: true });
    await target.locator('#entrants').fill('label,email\nann,ann@example.com\nben,ben@example.com');
    await target.click('#save-server-draft');
    await target.waitForFunction(() =>
      /Draft saved to the server|refused/.test(document.querySelector('#draw-status').textContent),
    );
    assert.match(
      await statusText(target),
      /Draft saved to the server \(public labels only\) until .*30 days after each save, at most 5 per wallet/,
    );
    await target.locator('#entrants').fill('changed');
    await target.click('#list-server-drafts');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('server draft(s)'));
    assert.equal(await target.locator('#server-draft option').count(), 1);
    await target.click('#load-server-draft');
    await target.waitForFunction(() =>
      document.querySelector('#draw-status').textContent.includes('Server draft loaded'),
    );
    // The contacts column never left the browser: the server copy holds the labels only.
    assert.equal(await target.locator('#entrants').inputValue(), 'ann\nben');
    await target.click('#delete-server-draft');
    await target.waitForFunction(() =>
      document.querySelector('#draw-status').textContent.includes('Server draft deleted'),
    );
    assert.equal(await target.locator('#server-draft-pick').isVisible(), false);
    await target.click('#list-server-drafts');
    await target.waitForFunction(() =>
      document.querySelector('#draw-status').textContent.includes('keeps no server drafts'),
    );
    // Five operations, each signed on its own by the stake key for the reward address.
    assert.deepEqual(await target.evaluate(() => window.signDataCalls), Array(5).fill(REWARD));
    assert.deepEqual(pageErrors, []);
    await target.close();
  }
  passed(
    'server drafts are saved, listed, loaded and deleted through the backend under the wallet stake key signature, labels only',
  );
  // BR-14: the privacy notice and the report channel are reachable from the page (plan step 13).
  {
    const ISSUES = 'https://github.com/Will413028/cardano-verifiable-giveaway/issues';
    const notice = await browser.newPage();
    const noticeErrors = [];
    notice.on('pageerror', (e) => noticeErrors.push(e.message));
    await notice.goto(origin);
    assert.equal(await notice.locator('#report-link').getAttribute('href'), ISSUES);
    await notice.click('#privacy-link');
    await notice.waitForSelector('#privacy-title');
    assert.equal(new URL(notice.url()).pathname, '/privacy.html');
    const text = await notice.locator('main').textContent();
    for (const expected of [
      /controller/,
      /12 calendar months \(UTC\) after the earlier of the draw's round time and the commitment's first hosting/,
      /up to 36 months/,
      /30 days after the last save/,
      /removed whole/,
      /keep your downloaded bundle and proof/,
      /do not paste personal data/,
      /not publicly deployed/,
    ])
      assert.match(text, expected);
    assert.equal(await notice.locator('#report-link').getAttribute('href'), ISSUES);
    await notice.setViewportSize({ width: 390, height: 844 });
    assert.ok(await notice.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await notice.click('header .brand');
    await notice.waitForSelector('#draw-form');
    assert.deepEqual(noticeErrors, []);
    await notice.close();
  }
  passed('privacy notice and the report channel are linked from the page');
  await page.selectOption('#network', 'demo');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  passed('mobile layout has no horizontal overflow');
  assert.deepEqual(errors, []);
  passed('no browser runtime errors');
  await mkdir(`${root}dist`, { recursive: true });
  await page.screenshot({ path: `${root}dist/demo-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.selectOption('#network', 'demo');
  await page.screenshot({ path: `${root}dist/demo-desktop.png`, fullPage: true });
  await writeFile(`${root}dist/browser-check.json`, JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
