// Plan step 8b: the built page against the real dev chain, nothing mocked except the CIP-30 wallet (test keys).
// Usage, with Dolos on the dev chain (after tools/devchain/acceptance.mjs), `make dev` on PORT (default 4320) and
// `make api` on 127.0.0.1:8787:
//   GIVEAWAY_PLAYWRIGHT_MODULE=… GIVEAWAY_CHROME_PATH=… node tools/devchain/browser-live.mjs <acceptance out dir>
// Checks the paths the mocks stand in for: CORS and answer shapes of the real MiniBF in Chrome, Evolution's
// Blockfrost provider decoding Dolos's /epochs/latest/parameters and /txs/{h}/utxos, submission to /tx/submit, the
// confirmation poll, and the backend's /tip forwarded to Dolos /blocks/latest.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transactionHash } from '@giveaway/verifier-cli/library';
import { cbor, hex, sign, Tag, unhex } from '../../tests/cardano.mjs';
import { BASE, utxos, WALLETS } from './devchain.mjs';

const out = process.argv[2];
if (!out) throw new Error('Usage: node tools/devchain/browser-live.mjs <acceptance out dir>');
const origin = `http://127.0.0.1:${process.env.PORT ?? 4320}/`;
const { chromium } = await import(process.env.GIVEAWAY_PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: process.env.GIVEAWAY_CHROME_PATH, headless: true });
const report = { browser: browser.version(), indexer: BASE };
try {
  // 1. Verification page, project indexer (the build default is the dev chain). After acceptance.mjs the enterprise
  // proof passes and the organizer proof fails on the overlapping commitment sent from its second address.
  const verifyPage = async (file) => {
    const page = await browser.newPage();
    const hosts = new Set();
    page.on('request', (r) => hosts.add(new URL(r.url()).origin));
    await page.goto(origin);
    await page
      .locator('#proof-file')
      .setInputFiles({ name: 'proof.json', mimeType: 'application/json', buffer: await readFile(`${out}/${file}`) });
    await page.waitForFunction(() => /PASS|FAIL/.test(document.querySelector('#verification').textContent), null, {
      timeout: 60000,
    });
    const result = {
      verdict: await page.locator('#verification').textContent(),
      checks: await page.locator('#checks > li').allTextContents(),
      hosts: [...hosts],
    };
    await page.close();
    return result;
  };
  report.verification = {
    enterprise: await verifyPage('proof-enterprise.json'),
    organizer: await verifyPage('proof.json'),
  };
  // 2. Creation page: a mock CIP-30 wallet holding a real dev-chain UTxO of the organizer base address.
  {
    const [utxo] = (await utxos(WALLETS.organizer.address)).filter((u) => u.lovelace === 50_000_000n);
    const [payment, stake] = WALLETS.organizer.keys;
    const utxoCbor = hex(
      cbor([
        [unhex(utxo.txHash), utxo.index],
        [unhex(WALLETS.organizer.hex), utxo.lovelace],
      ]),
    );
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.exposeFunction('mockSign', (unsigned) => {
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
    });
    await page.addInitScript(
      ({ utxo, address }) => {
        window.cardano = {
          mock: {
            name: 'Mock preprod',
            icon: '',
            apiVersion: '1',
            enable: async () => ({
              getNetworkId: async () => 0,
              getChangeAddress: async () => address,
              getUtxos: async () => [utxo],
              signTx: async (tx) => window.mockSign(tx),
            }),
          },
        };
      },
      { utxo: utxoCbor, address: WALLETS.organizer.hex },
    );
    await page.goto(origin);
    await page.selectOption('#network', 'preprod');
    await page.waitForSelector('#wallet option', { state: 'attached' });
    await page.waitForFunction(() => /block \d+|unavailable/.test(document.querySelector('#chain-tip').textContent));
    report.tip = await page.locator('#chain-tip').textContent();
    await page.click('#prepare');
    await page.waitForFunction(() =>
      /Ready to sign|Error|not|fail/i.test(document.querySelector('#draw-status').textContent),
    );
    report.prepared = await page.locator('#draw-status').textContent();
    await page.click('#commit');
    await page.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Submitted'));
    report.submitted = await page.locator('#draw-status').textContent();
    // The page polls every 30 s; the emulator makes 15 blocks in about 15 s.
    await page.waitForFunction(
      () => /Fifteen confirmations verified|expired|invalid/.test(document.querySelector('#draw-status').textContent),
      null,
      { timeout: 120000 },
    );
    report.confirmed = await page.locator('#draw-status').textContent();
    report.pageErrors = errors;
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
const accepted = JSON.parse(await readFile(`${out}/report.json`, 'utf8'));
assert.equal(report.verification.enterprise.verdict, 'PASS');
assert.equal(report.verification.organizer.verdict, 'FAIL');
assert.ok(
  report.verification.organizer.checks.some(
    (c) => c.includes('Unique commitment') && c.includes(accepted.overlap.txHash),
  ),
);
assert.match(report.tip, /block \d+/);
assert.match(report.prepared, /Ready to sign/);
assert.match(report.confirmed, /Fifteen confirmations verified/);
assert.deepEqual(report.pageErrors, []);
