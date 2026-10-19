// Plan steps 8b and 9: the built page against the real dev chain, nothing mocked except the CIP-30 wallet (test keys).
// Usage, with Dolos on the dev chain (after tools/devchain/acceptance.mjs) and `make dev` on PORT (default 4320):
//   GIVEAWAY_PLAYWRIGHT_MODULE=… GIVEAWAY_CHROME_PATH=… node tools/devchain/browser-live.mjs <acceptance out dir>
// GIVEAWAY_INDEXER_URL names the project indexer the page was built against (default: Dolos itself, DEVCHAIN_URL);
// step 9 builds it against the reverse proxy (deploy/dolos-proxy/nginx.conf in nginx before Dolos). Checks the paths
// the mocks stand in for: CORS and answer shapes of the real MiniBF (and proxy) in Chrome, Evolution's Blockfrost
// provider decoding /epochs/latest/parameters and /txs/{h}/utxos, the tip read from the project indexer, submission by
// the wallet (submitTx; the mock wallet sends to Dolos directly, as a wallet's own infrastructure would), the
// confirmation poll, and that the page reads chain data from the project indexer only (PD8 A: no backend in between).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transactionHash } from '@giveaway/verifier-cli/library';
import { cbor, hex, sign, Tag, unhex } from '../../tests/cardano.mjs';
import { BASE, submit, utxos, WALLETS } from './devchain.mjs';

const out = process.argv[2];
if (!out) throw new Error('Usage: node tools/devchain/browser-live.mjs <acceptance out dir>');
const origin = `http://127.0.0.1:${process.env.PORT ?? 4320}/`;
const INDEXER = (process.env.GIVEAWAY_INDEXER_URL ?? BASE).replace(/\/$/, '');
const { chromium } = await import(process.env.GIVEAWAY_PLAYWRIGHT_MODULE);
const browser = await chromium.launch({ executablePath: process.env.GIVEAWAY_CHROME_PATH, headless: true });
const report = { browser: browser.version(), indexer: INDEXER, dolos: BASE };
try {
  // 1. Verification page, project indexer (the build default is the dev chain). After acceptance.mjs the enterprise
  // proof passes and the organizer proof fails on the overlapping commitment sent from its second address.
  const verifyPage = async (file) => {
    const page = await browser.newPage();
    const hosts = new Set();
    const paths = [];
    page.on('request', (r) => {
      hosts.add(new URL(r.url()).origin);
      if (r.url().startsWith(INDEXER)) paths.push(new URL(r.url()).pathname);
    });
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
      evidenceSource: await page.locator('#evidence-source').textContent(),
      hosts: [...hosts],
      paths,
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
    const requests = [];
    page.on('request', (r) => requests.push({ method: r.method(), url: r.url() }));
    // The wallet's own infrastructure: the signed transaction goes to the dev chain directly, not through the page.
    const walletSubmits = [];
    await page.exposeFunction('mockSubmit', async (tx) => {
      const r = await submit(tx);
      walletSubmits.push(r.status);
      if (r.status !== 200) throw new Error(`submit rejected: ${r.status} ${r.body}`);
      return r.body.trim();
    });
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
              submitTx: async (tx) => window.mockSubmit(tx),
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
    report.walletSubmits = walletSubmits;
    report.creationHosts = [...new Set(requests.map((r) => new URL(r.url).origin))];
    report.creationPosts = requests.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS').map((r) => r.url);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
const accepted = JSON.parse(await readFile(`${out}/report.json`, 'utf8'));
// The page reads chain data only from the project indexer it was built against; nothing else, no backend.
const allowed = new Set([new URL(origin).origin, new URL(INDEXER).origin]);
for (const hosts of [report.verification.enterprise.hosts, report.verification.organizer.hosts, report.creationHosts])
  assert.ok(
    hosts.every((h) => allowed.has(h)),
    JSON.stringify(hosts),
  );
assert.ok(report.creationHosts.includes(new URL(INDEXER).origin));
assert.deepEqual(report.creationPosts, []);
assert.deepEqual(report.walletSubmits, [200]);
assert.equal(
  report.verification.enterprise.evidenceSource,
  `Chain evidence source: ${INDEXER} (the project indexer). The result depends on what this indexer reports.`,
);
assert.equal(report.verification.enterprise.verdict, 'PASS');
// The selected test transaction's metadata, read through the project indexer: its listing's metadata JSON and the
// CBOR the commitment is decoded from.
const selected = JSON.parse(await readFile(`${out}/proof-enterprise.json`, 'utf8')).txHash;
for (const part of ['metadata', 'cbor'])
  assert.ok(report.verification.enterprise.paths.includes(`/txs/${selected}/${part}`), part);
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
