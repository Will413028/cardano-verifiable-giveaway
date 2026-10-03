import { BrowserWallet, MeshTxBuilder, KoiosProvider, cst } from '@meshsdk/core';
import { LABEL, commitmentMetadata } from './metadata.mjs';

const output = document.querySelector('#output');
const setOutput = value => { output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };
let wallet, unsigned, metadata, protocolParams;
let busy = false;
async function run(action) {
  if (busy) return;
  busy = true;
  try { await action(); } catch (e) { setOutput(e.message); } finally { busy = false; }
}
function refreshWallets() {
  const select = document.querySelector('#wallet');
  const selected = select.value;
  const wallets = BrowserWallet.getInstalledWallets();
  select.replaceChildren();
  for (const { id, name } of wallets) {
    const option = document.createElement('option'); option.value = id; option.textContent = name;
    select.append(option);
  }
  if (wallets.some(w => w.id === selected)) select.value = selected;
  document.querySelector('#connect').disabled = wallets.length === 0;
  if (!wallets.length) setOutput('No CIP-30 wallet detected in this browser profile. Install or enable your wallet extension in this browser, allow it on this page, then click Refresh wallets.');
  else if (!wallet) setOutput(`Detected wallet: ${select.selectedOptions[0].textContent}. Ready to connect.`);
  return wallets;
}
refreshWallets();
document.querySelector('#refresh').onclick = refreshWallets;
document.querySelector('#connect').onclick = () => run(async () => {
  wallet = undefined;
  unsigned = undefined;
  const id = document.querySelector('#wallet').value;
  if (!id || typeof window.cardano?.[id]?.enable !== 'function') {
    refreshWallets();
    throw new Error('No selected CIP-30 wallet is available in this browser. Check the extension and click Refresh wallets.');
  }
  try { wallet = await BrowserWallet.enable(id); }
  catch (e) { throw new Error(`Wallet ${id} could not connect: ${e.message}. Check whether its connection request was rejected or the extension is locked.`); }
  if (await wallet.getNetworkId() !== 0) { wallet = undefined; throw new Error('Mainnet is forbidden. Switch to preprod.'); }
  setOutput({ connected: true, browser: navigator.userAgent, note: 'Testnet id alone does not distinguish preview from preprod; build verifies the selected UTxO on preprod.' });
});
document.querySelector('#build').onclick = () => run(async () => {
  unsigned = undefined;
  if (!wallet) throw new Error('Connect a preprod wallet first');
  if (await wallet.getNetworkId() !== 0) throw new Error('Mainnet is forbidden');
  const utxos = await wallet.getUtxos();
  const candidate = utxos.find(u => u.output.amount.length === 1 &&
    u.output.amount[0].unit === 'lovelace' && BigInt(u.output.amount[0].quantity) >= 5000000n);
  if (!candidate) throw new Error('Need one ADA-only preprod UTxO containing at least 5 test ADA');
  const provider = new KoiosProvider('preprod');
  protocolParams = await provider.fetchProtocolParameters();
  const verified = (await provider.fetchUTxOs(candidate.input.txHash, candidate.input.outputIndex))[0];
  if (!verified || verified.output.address !== candidate.output.address ||
      JSON.stringify(verified.output.amount) !== JSON.stringify(candidate.output.amount)) {
    throw new Error('Selected wallet UTxO is not confirmed on preprod');
  }
  const address = await wallet.getChangeAddress();
  const bundle = JSON.stringify({ entrants: ['alice', 'bob', 'carol'], winners: 1, purpose: 'spike-a' });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bundle));
  const bundleHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const round = Math.floor((Date.now() / 1000 + 1800 - 1692803367) / 3) + 1;
  metadata = commitmentMetadata({ drawId: crypto.randomUUID(), bundleHash, round });
  unsigned = await new MeshTxBuilder({ fetcher: provider, params: protocolParams })
    .txOut(address, [{ unit: 'lovelace', quantity: '2000000' }])
    .metadataValue(LABEL, metadata).changeAddress(address).selectUtxosFrom([verified]).complete();
  setOutput({ metadata, unsignedBytes: unsigned.length / 2,
    feeLovelace: cst.Transaction.fromCbor(unsigned).body().fee().toString(),
    note: 'Returns 2 test ADA to your own change address; only the fee is spent. Signing has not started.' });
});
document.querySelector('#sign').onclick = () => run(async () => {
  if (!unsigned) throw new Error('Build and review a transaction first');
  if (await wallet.getNetworkId() !== 0) throw new Error('Mainnet is forbidden');
  const signed = await wallet.signTx(unsigned);
  const feeLovelace = cst.Transaction.fromCbor(signed).body().fee().toString();
  const formulaFee = protocolParams.minFeeA * (signed.length / 2) + protocolParams.minFeeB;
  if (Number(feeLovelace) > 2 * formulaFee) throw new Error('STOP: fee exceeds twice the live protocol formula estimate');
  // Fixed preprod submitter prevents a wallet network switch from submitting elsewhere.
  const submittedAt = new Date().toISOString();
  const txHash = await new KoiosProvider('preprod').submitTx(signed);
  const sample = { txHash, submittedAt, signedBytes: signed.length / 2,
    feeLovelace, formulaFee, protocolEpoch: protocolParams.epoch,
    metadata, label: LABEL, browser: navigator.userAgent };
  unsigned = undefined;
  setOutput(sample);
  const link = document.querySelector('#download');
  if (link.href.startsWith('blob:')) URL.revokeObjectURL(link.href);
  link.href = URL.createObjectURL(new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json' }));
  link.download = `spike-a-${txHash}.json`; link.hidden = false;
});
