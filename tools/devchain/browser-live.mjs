// Plan steps 8b, 9 and 9b: the built page against the real dev chain, nothing mocked except the CIP-30 wallet (test keys).
// Usage, with Dolos on the dev chain (after tools/devchain/acceptance.mjs) and `make dev` on PORT (default 4320):
//   GIVEAWAY_PLAYWRIGHT_MODULE=… GIVEAWAY_CHROME_PATH=… node tools/devchain/browser-live.mjs <acceptance out dir>
// GIVEAWAY_INDEXER_URL names the project indexer the page was built against (default: Dolos itself, DEVCHAIN_URL);
// step 9 builds it against the reverse proxy (deploy/dolos-proxy/nginx.conf in nginx before Dolos). Checks the paths
// the mocks stand in for: CORS and answer shapes of the real MiniBF (and proxy) in Chrome, Evolution's Blockfrost
// provider decoding /epochs/latest/parameters and /txs/{h}/utxos, the tip read from the project indexer, submission by
// the wallet (submitTx; the mock wallet sends to Dolos directly, as a wallet's own infrastructure would), the
// confirmation poll, and that the page reads chain data from the project indexer only (PD8 A: no backend in between).
// Step 9b (PD10): the stake account read (/accounts/{stake}) and the commitment's 0 ADA withdrawal, the enterprise
// refusal on the verification page, and the setup explanation for a stake key that was never registered.
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
  // 1. Verification page, project indexer (the build default is the dev chain). After acceptance.mjs the second
  // identity's proof passes, the organizer proof fails on the overlapping commitment sent from its second address and
  // the enterprise proof fails with the reason (PD10).
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
    other: await verifyPage('proof-other.json'),
    organizer: await verifyPage('proof.json'),
    enterprise: await verifyPage('proof-enterprise.json'),
  };
  // 2. Creation page: a mock CIP-30 wallet holding a real dev-chain UTxO of `wallet`'s base address. With `commit`, it
  // signs, submits and waits for the confirmations; otherwise it records what preparing says.
  const creation = async (wallet, commit) => {
    const result = {};
    const [utxo] = (await utxos(wallet.address)).filter((u) => u.lovelace === 50_000_000n);
    const [payment, stake] = wallet.keys;
    const utxoCbor = hex(
      cbor([
        [unhex(utxo.txHash), utxo.index],
        [unhex(wallet.hex), utxo.lovelace],
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
                return window.mockSign(tx);
              },
              submitTx: async (tx) => window.mockSubmit(tx),
            }),
          },
        };
      },
      { utxo: utxoCbor, address: wallet.hex },
    );
    await page.goto(origin);
    await page.selectOption('#network', 'preprod');
    await page.waitForSelector('#wallet option', { state: 'attached' });
    await page.waitForFunction(() => /block \d+|unavailable/.test(document.querySelector('#chain-tip').textContent));
    result.tip = await page.locator('#chain-tip').textContent();
    await page.click('#prepare');
    await page.waitForFunction(() =>
      /Ready to sign|Error|not|fail/i.test(document.querySelector('#draw-status').textContent),
    );
    result.prepared = await page.locator('#draw-status').textContent();
    if (commit) {
      await page.click('#commit');
      await page.waitForFunction(() => document.querySelector('#draw-status').textContent.includes('Submitted'));
      result.submitted = await page.locator('#draw-status').textContent();
      // The page polls every 30 s; the emulator makes 15 blocks in about 15 s.
      await page.waitForFunction(
        () => /Fifteen confirmations verified|expired|invalid/.test(document.querySelector('#draw-status').textContent),
        null,
        { timeout: 120000 },
      );
      result.confirmed = await page.locator('#draw-status').textContent();
      // What the wallet sent: the commitment's body fields and withdrawals, read back from the dev chain.
      const txHash = result.submitted.match(/[a-f0-9]{64}/)?.[0];
      result.withdrawals = txHash ? await fetch(`${BASE}/txs/${txHash}/withdrawals`).then((r) => r.json()) : null;
    }
    result.pageErrors = errors;
    result.walletSubmits = walletSubmits;
    result.signCalls = await page.evaluate(() => window.signCalls ?? null);
    result.hosts = [...new Set(requests.map((r) => new URL(r.url).origin))];
    result.posts = requests.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS').map((r) => r.url);
    result.indexerPaths = requests
      .filter((r) => r.url.startsWith(INDEXER))
      .map((r) => new URL(r.url).pathname.replace(/[a-f0-9]{64}/, '{h}').replace(/stake_test1\w+/, '{stake}'));
    await page.close();
    return result;
  };
  report.creation = await creation(WALLETS.organizer, true);
  report.unregistered = await creation(WALLETS.unregistered, false);
} finally {
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
const accepted = JSON.parse(await readFile(`${out}/report.json`, 'utf8'));
// The page reads chain data only from the project indexer it was built against; nothing else, no backend.
const allowed = new Set([new URL(origin).origin, new URL(INDEXER).origin]);
const v = report.verification;
for (const hosts of [
  v.other.hosts,
  v.organizer.hosts,
  v.enterprise.hosts,
  report.creation.hosts,
  report.unregistered.hosts,
])
  assert.ok(
    hosts.every((h) => allowed.has(h)),
    JSON.stringify(hosts),
  );
assert.ok(report.creation.hosts.includes(new URL(INDEXER).origin));
assert.deepEqual(report.creation.posts, []);
assert.deepEqual(report.creation.walletSubmits, [200]);
assert.equal(
  v.other.evidenceSource,
  `Chain evidence source: ${INDEXER} (the project indexer). The result depends on what this indexer reports.`,
);
assert.equal(v.other.verdict, 'PASS');
// The selected test transaction's metadata, read through the project indexer: the withdrawal list's metadata JSON and
// the CBOR the commitment is decoded from.
const selected = JSON.parse(await readFile(`${out}/proof-other.json`, 'utf8')).txHash;
for (const part of ['metadata', 'cbor']) assert.ok(v.other.paths.includes(`/txs/${selected}/${part}`), part);
assert.ok(v.other.paths.some((p) => /^\/accounts\/stake_test1\w+\/withdrawals$/.test(p)));
assert.equal(v.organizer.verdict, 'FAIL');
assert.ok(v.organizer.checks.some((c) => c.includes('Unique commitment') && c.includes(accepted.overlap.txHash)));
// PD10: the enterprise organizer is refused with the reason, before any indexer request.
assert.equal(v.enterprise.verdict, 'FAIL');
assert.ok(v.enterprise.checks.some((c) => /must be a base address with a stake key/.test(c)));
assert.deepEqual(v.enterprise.paths, []);
assert.match(report.creation.tip, /block \d+/);
assert.match(report.creation.prepared, /Ready to sign/);
assert.ok(report.creation.indexerPaths.includes('/accounts/{stake}'));
assert.match(report.creation.confirmed, /Fifteen confirmations verified/);
assert.deepEqual(report.creation.withdrawals, [
  { address: accepted.registration.organizer.account.stake_address, amount: '0' },
]);
assert.deepEqual(report.creation.pageErrors, []);
// A stake key that never registered: the page explains the separate setup transaction and asks for no signature.
assert.match(report.unregistered.prepared, /is not registered.*separate transaction/);
assert.equal(report.unregistered.signCalls, 0);
assert.deepEqual(report.unregistered.posts, []);
assert.deepEqual(report.unregistered.pageErrors, []);
