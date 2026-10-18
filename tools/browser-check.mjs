import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeBech32, LABEL, QUICKNET, VERSION } from '@giveaway/verifier-cli/library';
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
  const preprod = await browser.newPage();
  const params = JSON.parse(await readFile(`${root}tests/epoch-params.json`, 'utf8'));
  const addressHex = `60${'00'.repeat(28)}`;
  const address = encodeBech32(
    'addr_test',
    Uint8Array.from(addressHex.match(/../g), (b) => parseInt(b, 16)),
  );
  // CIP-30 UTxO CBOR: [[tx id, index], [address, 10 ADA]].
  const utxo = `82825820${'00'.repeat(32)}0082581d${addressHex}1a00989680`;
  const submitted = 'ab'.repeat(32);
  // Koios mock shared by the preprod pages; `txInfo` answers lookups of the submitted commitment.
  const routePreprod = (target, txInfo) =>
    target.route('https://preprod.koios.rest/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname.split('/').at(-1);
      if (path === 'submittx') return route.fulfill({ status: 202, json: submitted });
      if (txInfo && path === 'tx_info' && route.request().postData()?.includes(submitted)) return txInfo(route);
      const data =
        path === 'tip'
          ? [{ epoch_no: params[0].epoch_no }]
          : path === 'epoch_params'
            ? params
            : path === 'tx_metadata'
              ? []
              : path === 'utxo_info'
                ? [
                    {
                      tx_hash: '00'.repeat(32),
                      tx_index: 0,
                      address,
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
  // A CIP-30 mock; with `sign` it approves by returning an empty witness set (`a0`), so no key exists anywhere in the check.
  const mockWallet = ({ utxo, sign }) => {
    window.cardano = {
      mock: {
        name: 'Mock preprod',
        icon: '',
        apiVersion: '1',
        enable: async () => ({
          getNetworkId: async () => 0,
          getChangeAddress: async () => `60${'00'.repeat(28)}`,
          getUtxos: async () => [utxo],
          signTx: async () => {
            if (sign) return 'a0';
            throw new Error('No signing allowed in automated browser checks');
          },
        }),
      },
    };
  };
  await routePreprod(preprod);
  await preprod.addInitScript(mockWallet, { utxo, sign: false });
  await preprod.goto('http://127.0.0.1:4320/');
  await preprod.selectOption('#network', 'preprod');
  await preprod.waitForSelector('#wallet option', { state: 'attached' });
  await preprod.click('#prepare');
  await preprod.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Ready to sign'));
  assert.match(await preprod.locator('#draw-status').textContent(), /Estimated fee/);
  assert.equal(await preprod.locator('#commit').textContent(), 'Sign and submit to preprod');
  await preprod.close();
  passed('mock preprod wallet builds unsigned commitment and displays fee');
  // The confirmation poll waits on Koios while the draw is reset; the late answer must not reach the page.
  // `indexed` covers the success path (the commitment is found and confirmed) and the error path (not yet indexed).
  for (const indexed of [false, true]) {
    const stale = await browser.newPage();
    const staleErrors = [];
    stale.on('pageerror', (e) => staleErrors.push(e.message));
    await stale.clock.install();
    let release, polled;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const pollSeen = new Promise((resolve) => {
      polled = resolve;
    });
    const included = Math.floor(Date.now() / 1000);
    await routePreprod(stale, async (route) => {
      polled();
      await held;
      await route.fulfill({
        json: indexed
          ? [
              {
                tx_hash: submitted,
                inputs: [{ payment_addr: { bech32: address } }],
                block_height: 100,
                tx_timestamp: included,
              },
            ]
          : [],
      });
    });
    // Registered after the shared mock, so these take precedence for the poll's later reads.
    await stale.route('https://preprod.koios.rest/api/v1/blocks**', (route) =>
      route.fulfill({ json: [{ block_height: 114, block_time: included + 60 }] }),
    );
    await stale.route('https://preprod.koios.rest/api/v1/tx_metadata', (route) =>
      route.fulfill({
        json: indexed
          ? [
              {
                tx_hash: submitted,
                metadata: {
                  [LABEL]: {
                    protocol: VERSION,
                    drawId: 'stale',
                    bundleHash: 'cd'.repeat(32),
                    chainHash: QUICKNET,
                    round: 1,
                  },
                },
              },
            ]
          : [],
      }),
    );
    await stale.addInitScript(mockWallet, { utxo, sign: true });
    await stale.goto('http://127.0.0.1:4320/');
    await stale.selectOption('#network', 'preprod');
    await stale.waitForSelector('#wallet option', { state: 'attached' });
    await stale.click('#prepare');
    await stale.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Ready to sign'));
    await stale.click('#commit');
    await stale.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Submitted'));
    await stale.clock.fastForward(31000);
    await pollSeen;
    await stale.selectOption('#network', 'demo');
    const statusAfterReset = await stale.locator('#draw-status').textContent();
    // The last request of each path: the confirmation block when indexed, the metadata read otherwise.
    const lastRead = stale.waitForResponse((r) => r.url().includes(indexed ? '/blocks' : '/tx_metadata'));
    release();
    await lastRead;
    await stale.waitForTimeout(500);
    assert.equal(await stale.locator('#draw-status').textContent(), statusAfterReset);
    assert.equal(await stale.locator('#open').isVisible(), false);
    assert.deepEqual(staleErrors, []);
    await stale.close();
  }
  passed('confirmation response after a reset is discarded');
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
