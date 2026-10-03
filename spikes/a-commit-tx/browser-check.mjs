import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
if (!process.env.SPIKE_PLAYWRIGHT_MODULE || !process.env.SPIKE_CHROME_PATH) {
  throw new Error('Set SPIKE_PLAYWRIGHT_MODULE and SPIKE_CHROME_PATH to existing installations');
}
const { chromium } = await import(process.env.SPIKE_PLAYWRIGHT_MODULE);
console.log('Launching isolated headless Chrome');
const browser = await chromium.launch({ executablePath: process.env.SPIKE_CHROME_PATH, headless: true, timeout: 20000 });
console.log('Chrome launched');
const report = { timestamp: new Date().toISOString(), browser: browser.version(), tests: [] };
try {
  const page = await browser.newPage();
  if (process.env.SPIKE_WALLET_BUNDLE) {
    const body = await readFile(process.env.SPIKE_WALLET_BUNDLE);
    await page.route('**/dist/wallet.js', route => route.fulfill({ body, contentType: 'text/javascript' }));
  }
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:', e.message); });
  await page.goto('http://127.0.0.1:4310/');
  console.log('Wallet page opened');
  try {
    await page.waitForFunction(() => document.querySelector('#output').textContent.includes('No CIP-30'), undefined, { timeout: 10000 });
  } catch (e) { throw new Error(`Wallet initialization failed: ${errors.join('; ')}; ${e.message}`); }
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#connect').isDisabled(), true);
  assert.equal(await page.locator('#wallet option').count(), 0);
  report.tests.push({ name: 'wallet page without extension loads', status: 'PASS' });
  report.tests.push({ name: 'no wallet disables connect rather than calling enable with an empty id', status: 'PASS' });
  await page.evaluate(() => {
    window.cardano = { delayed: { name: 'Delayed mock', icon: '', apiVersion: '1',
      enable: async () => ({ getNetworkId: async () => 0 }) } };
  });
  await page.click('#refresh');
  assert.equal(await page.locator('#connect').isDisabled(), false);
  assert.equal(await page.locator('#wallet').inputValue(), 'delayed');
  report.tests.push({ name: 'refresh detects a wallet injected after page initialization', status: 'PASS' });
  console.log('Wallet page load PASS');
  const mesh = await page.evaluate(async () => {
    const { MeshTxBuilder, cst } = await import('/dist/mesh.js');
    const address = cst.Address.fromBytes('60' + '00'.repeat(28)).toBech32();
    const utxo = { input: { txHash: '00'.repeat(32), outputIndex: 0 },
      output: { address, amount: [{ unit: 'lovelace', quantity: '10000000' }] } };
    const txHex = await new MeshTxBuilder().txOut(address, [{ unit: 'lovelace', quantity: '2000000' }])
      .metadataValue(674, { probe: 'browser' }).changeAddress(address).selectUtxosFrom([utxo]).complete();
    return { bytes: txHex.length / 2, feeLovelace: cst.Transaction.fromCbor(txHex).body().fee().toString() };
  });
  report.tests.push({ name: 'Mesh builds unsigned synthetic transaction in browser', status: 'PASS', ...mesh });
  console.log('Mesh browser transaction PASS');
  const mainnet = await browser.newPage();
  await mainnet.addInitScript(() => {
    window.cardano = { mock: { name: 'Mock wallet', icon: '', apiVersion: '1',
      enable: async () => ({ getNetworkId: async () => 1 }) } };
  });
  await mainnet.goto('http://127.0.0.1:4310/');
  await mainnet.waitForSelector('#wallet option', { state: 'attached', timeout: 10000 });
  await mainnet.click('#connect');
  await mainnet.waitForFunction(() => document.querySelector('#output').textContent.includes('Mainnet is forbidden'));
  await mainnet.click('#build');
  await mainnet.waitForFunction(() => document.querySelector('#output').textContent.includes('Connect a preprod wallet first'));
  report.tests.push({ name: 'CIP-30 mock mainnet wallet rejected before build', status: 'PASS' });
  console.log('Mock mainnet rejection PASS');
  await mainnet.close();
  const preprod = await browser.newPage();
  const params = JSON.parse(await readFile(new URL('dist/epoch-params.json', import.meta.url), 'utf8'));
  const address = 'addr_test1vqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqd9tg5t';
  await preprod.route('https://preprod.koios.rest/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/').at(-1);
    const data = path === 'tip' ? [{ epoch_no: params[0].epoch_no }] : path === 'epoch_params' ? params :
      path === 'tx_info' ? [{ tx_hash: '00'.repeat(32), outputs: [{ tx_hash: '00'.repeat(32), tx_index: 0,
        payment_addr: { bech32: address }, value: '10000000', asset_list: [],
        datum_hash: null, inline_datum: null, reference_script: null }] }] : undefined;
    if (!data) throw new Error(`Unexpected mock request: ${path}`);
    await route.fulfill({ json: data });
  });
  await preprod.addInitScript(() => {
    window.cardano = { mock: { name: 'Mock preprod', icon: '', apiVersion: '1', enable: async () => ({
      getNetworkId: async () => 0,
      getChangeAddress: async () => '60' + '00'.repeat(28),
      getUtxos: async () => {
        const { cst } = await import('/dist/mesh.js');
        const address = cst.Address.fromBytes('60' + '00'.repeat(28)).toBech32();
        return [cst.TransactionUnspentOutput.fromCore([{ txId: '00'.repeat(32), index: 0 },
          { address, value: { coins: 10000000n } }]).toCbor()];
      },
      signTx: async () => { throw new Error('Signing forbidden in browser automation'); },
    }) } };
  });
  await preprod.goto('http://127.0.0.1:4310/');
  await preprod.waitForSelector('#wallet option', { state: 'attached' });
  await preprod.click('#connect');
  await preprod.waitForFunction(() => document.querySelector('#output').textContent.includes('"connected": true'));
  await preprod.click('#build');
  await preprod.waitForFunction(() => document.querySelector('#output').textContent.includes('unsignedBytes'), undefined, { timeout: 10000 });
  const built = JSON.parse(await preprod.locator('#output').textContent());
  assert.ok(built.unsignedBytes > 0);
  report.tests.push({ name: 'CIP-30 mock preprod connect and build with mocked Koios', status: 'PASS',
    bytes: built.unsignedBytes, feeLovelace: built.feeLovelace });
  console.log('Mock preprod UI build PASS');
  await preprod.close();
  try {
    const lucid = await page.evaluate(async () => Promise.race([ (async () => {
      const { Lucid, CML } = await import('/dist/lucid.js');
      if (typeof Lucid !== 'function' || !CML) throw new Error('Lucid exports unavailable');
      const address = CML.Address.from_hex('60' + '00'.repeat(28)).to_bech32();
      const instance = await Lucid(undefined, 'Preprod');
      return { address, hasTransactionBuilder: typeof instance.newTx === 'function' };
    })(), new Promise((_, reject) => setTimeout(() => reject(new Error('Lucid initialization exceeded 20 seconds')), 20000)) ]));
    assert.equal(lucid.hasTransactionBuilder, true);
    report.tests.push({ name: 'Lucid browser WASM initialization', status: 'PASS', ...lucid });
  } catch (e) { report.tests.push({ name: 'Lucid browser WASM initialization', status: 'FAIL', error: e.message }); }
  await writeFile(new URL('dist/browser-check.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.tests.some(x => x.status === 'FAIL')) process.exitCode = 1;
} finally { await browser.close(); }
