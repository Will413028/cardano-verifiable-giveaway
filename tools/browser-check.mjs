import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commitmentValidUntil, encodeBech32, roundTime, transactionHash } from '@giveaway/verifier-cli/library';
import { cbor, hex, sign, Tag, testKey, unhex } from '../tests/cardano.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
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
  await page.goto('http://127.0.0.1:4320/');
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
  assert.equal(await independent.locator('#verified-winners li').count(), 1);
  await independent.locator('#lookup').fill('alice');
  assert.match(await independent.locator('#lookup-result').textContent(), /is in this bundle/);
  await independent.locator('#lookup').fill('not-in-list');
  assert.match(await independent.locator('#lookup-result').textContent(), /not in this bundle/);
  passed('fresh page independently verifies shared result');
  const downloadEvent = page.waitForEvent('download');
  await page.click('#download');
  const download = await downloadEvent;
  const path = await download.path();
  const artifact = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(artifact.bundle.entrants, ['alice', 'bob', 'carol']);
  assert.equal(JSON.stringify(artifact).includes('example.com'), false);
  const cli = spawnSync(process.execPath, [`${root}apps/verifier-cli/index.mjs`, path], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).status, 'DEMO PASS');
  passed('downloaded public bundle strips contacts and independently passes CLI');
  artifact.winners = ['mallory'];
  await independent.locator('#proof-file').setInputFiles({
    name: 'tampered.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await independent.waitForFunction(() => document.querySelector('#verification').textContent === 'FAIL');
  passed('tampered winner rejected in browser verifier');
  assert.equal(await independent.locator('#verified-result').isVisible(), false);
  await independent.route('https://fixture.invalid/proof.json', (route) =>
    route.fulfill({
      json: { ...artifact, winners: JSON.parse(Buffer.from(link.split('#proof=')[1], 'base64url').toString()).winners },
    }),
  );
  await independent.locator('#bundle-url').fill('https://fixture.invalid/proof.json');
  await independent.click('#load-url');
  await independent.waitForFunction(() => document.querySelector('#verification').textContent === 'DEMO PASS');
  const hostedLink = await independent.locator('#share-link').inputValue();
  assert.ok(hostedLink.includes('hash='));
  await independent.goto(hostedLink.replace(/hash=[a-f0-9]+/, `hash=${'0'.repeat(64)}`));
  await independent.waitForFunction(() =>
    document.querySelector('#verification').textContent.includes('hash does not match'),
  );
  passed('hosted bundle sharing pins file hash and rejects changed content');
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
  await mainnet.goto('http://127.0.0.1:4320/');
  await mainnet.selectOption('#network', 'preprod');
  await mainnet.waitForSelector('#wallet option', { state: 'attached' });
  await mainnet.click('#prepare');
  await mainnet.waitForFunction(() =>
    document.querySelector('#draw-status').textContent.includes('Mainnet is disabled'),
  );
  assert.equal(await mainnet.locator('#commit').isVisible(), false);
  await mainnet.close();
  passed('mock mainnet wallet cannot build or submit');
  const params = JSON.parse(await readFile(`${root}tests/epoch-params.json`, 'utf8'));
  // Two wallets: an enterprise address that never signs, and a base address whose test keys (tests/cardano.mjs,
  // seeds 1 and 2) sign in Node through an exposed function, so the page gets real vkey witnesses.
  const payment = testKey(1);
  const stake = testKey(2);
  const wallets = {
    enterprise: `60${'00'.repeat(28)}`,
    base: `00${payment.hash}${stake.hash}`,
  };
  const bech32 = (hex) => encodeBech32('addr_test', unhex(hex));
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
  // Koios mock shared by the preprod pages. A submitted transaction is kept and served back from tx_cbor (through
  // `txCbor`, which may hold or withhold it) and tx_info; `utxoIndex` lets the indexer report another output.
  const routePreprod = (target, addressHex, { txCbor, utxoIndex = 0 } = {}) => {
    const submitted = new Map();
    return target.route('https://preprod.koios.rest/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.split('/').at(-1);
      if (path === 'submittx') {
        const body = hex(route.request().postDataBuffer());
        submitted.set(transactionHash(body), body);
        return route.fulfill({ status: 202, json: transactionHash(body) });
      }
      const asked = route.request().postDataJSON?.()?._tx_hashes ?? [];
      const known = asked.filter((h) => submitted.has(h)).map((h) => ({ tx_hash: h, cbor: submitted.get(h) }));
      if (path === 'tx_cbor' && txCbor) return txCbor(route, known);
      const data =
        path === 'tip'
          ? [{ epoch_no: params[0].epoch_no }]
          : path === 'epoch_params'
            ? params
            : path === 'tx_cbor' || path === 'tx_metadata'
              ? []
              : path === 'tx_info'
                ? known.map((t) => ({ tx_hash: t.tx_hash, inputs: [{ payment_addr: { bech32: bech32(addressHex) } }] }))
                : path === 'utxo_info'
                  ? [
                      {
                        tx_hash: '00'.repeat(32),
                        tx_index: utxoIndex,
                        address: bech32(addressHex),
                        value: '10000000',
                        asset_list: [],
                        datum_hash: null,
                        inline_datum: null,
                        reference_script: null,
                      },
                    ]
                  : undefined;
      if (!data) throw new Error(`Unexpected mock preprod request: ${path}`);
      await route.fulfill({ json: data });
    });
  };
  // A CIP-30 mock. With `sign` it approves through the exposed `mockSign`; every signTx call is counted.
  const mockWallet = ({ utxo, address, sign }) => {
    window.signCalls = 0;
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
        }),
      },
    };
  };
  const preprodPage = async ({ wallet = 'enterprise', sign = false, clock = false, ...route } = {}) => {
    const target = await browser.newPage();
    const pageErrors = [];
    target.on('pageerror', (e) => pageErrors.push(e.message));
    if (clock) await target.clock.install();
    await target.exposeFunction('mockSign', witnessSet);
    await routePreprod(target, wallets[wallet], route);
    await target.addInitScript(mockWallet, { utxo: utxoOf(wallets[wallet]), address: wallets[wallet], sign });
    await target.goto('http://127.0.0.1:4320/');
    await target.selectOption('#network', 'preprod');
    await target.waitForSelector('#wallet option', { state: 'attached' });
    return { target, pageErrors };
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
  // The indexer reports the wallet's UTxO under another output index; the SDK builds a transaction spending that
  // output, and the re-read of the unsigned CBOR must stop it before the wallet is asked to sign.
  {
    const { target } = await preprodPage({ utxoIndex: 1 });
    await target.click('#prepare');
    await target.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('unexpected input'));
    assert.equal(await target.locator('#commit').isVisible(), false);
    assert.equal(await target.evaluate(() => window.signCalls), 0);
    await target.close();
  }
  passed('unsigned transaction that differs from the plan is never signed');
  // The confirmation poll waits on Koios while the draw is reset; the late answer must not reach the page.
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
    const { target: stale, pageErrors: staleErrors } = await preprodPage({
      wallet: 'base',
      sign: true,
      clock: true,
      txCbor: async (route, known) => {
        polled();
        await held;
        await route.fulfill({
          json: indexed ? known.map((t) => ({ ...t, block_height: 100, tx_timestamp: included })) : [],
        });
      },
    });
    // Registered after the shared mock, so it takes precedence for the poll's confirmation read.
    await stale.route('https://preprod.koios.rest/api/v1/blocks**', (route) =>
      route.fulfill({ json: [{ block_height: 114, block_time: included + 60 }] }),
    );
    await stale.click('#prepare');
    await stale.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Ready to sign'));
    await stale.click('#commit');
    await stale.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Submitted'));
    assert.equal(await stale.evaluate(() => window.signCalls), 1);
    await stale.clock.fastForward(31000);
    await pollSeen;
    await stale.selectOption('#network', 'demo');
    const statusAfterReset = await statusText(stale);
    // The last request of each path: the confirmation block when indexed, the CBOR read otherwise.
    const lastRead = stale.waitForResponse((r) => r.url().includes(indexed ? '/blocks' : '/tx_cbor'));
    release();
    await lastRead;
    await stale.waitForTimeout(500);
    assert.equal(await statusText(stale), statusAfterReset);
    assert.equal(await stale.locator('#open').isVisible(), false);
    assert.deepEqual(staleErrors, []);
    await stale.close();
  }
  passed('confirmation response after a reset is discarded');
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
