import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cst } from '@meshsdk/core';
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
  assert.equal(await independent.locator('#checks li').count(), 8);
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
  const address = cst.Address.fromBytes(`60${'00'.repeat(28)}`).toBech32();
  const utxo = cst.TransactionUnspentOutput.fromCore([
    { txId: '00'.repeat(32), index: 0 },
    { address, value: { coins: 10000000n } },
  ]).toCbor();
  await preprod.route('https://preprod.koios.rest/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1);
    const data =
      path === 'tip'
        ? [{ epoch_no: params[0].epoch_no }]
        : path === 'epoch_params'
          ? params
          : path === 'tx_info'
            ? [
                {
                  tx_hash: '00'.repeat(32),
                  outputs: [
                    {
                      tx_hash: '00'.repeat(32),
                      tx_index: 0,
                      payment_addr: { bech32: address },
                      value: '10000000',
                      asset_list: [],
                      datum_hash: null,
                      inline_datum: null,
                      reference_script: null,
                    },
                  ],
                },
              ]
            : undefined;
    if (!data) throw new Error(`Unexpected mock preprod request: ${path}`);
    await route.fulfill({ json: data });
  });
  await preprod.addInitScript(
    ({ utxo }) => {
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
              throw new Error('No signing allowed in automated browser checks');
            },
          }),
        },
      };
    },
    { utxo },
  );
  await preprod.goto('http://127.0.0.1:4320/');
  await preprod.selectOption('#network', 'preprod');
  await preprod.waitForSelector('#wallet option', { state: 'attached' });
  await preprod.click('#prepare');
  await preprod.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Ready to sign'));
  assert.match(await preprod.locator('#draw-status').textContent(), /Estimated fee/);
  assert.equal(await preprod.locator('#commit').textContent(), 'Sign and submit to preprod');
  await preprod.close();
  passed('mock preprod wallet builds unsigned commitment and displays fee');
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
