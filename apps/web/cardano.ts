import { BrowserWallet, MeshTxBuilder, KoiosProvider, cst } from '@meshsdk/core';
import { computeCommitment, type Bundle } from '../../packages/protocol/index.ts';
import { commitmentMetadata, LABEL } from '../../packages/chain/index.ts';

export function wallets() { return BrowserWallet.getInstalledWallets(); }
export async function prepareTransaction(bundle: Bundle, id: string) {
  if (!id || typeof (window as any).cardano?.[id]?.enable !== 'function') throw new Error('Install and enable a CIP-30 wallet in this browser, then refresh wallets');
  const wallet = await BrowserWallet.enable(id);
  if (await wallet.getNetworkId() !== 0) throw new Error('Switch your wallet to preprod. Mainnet is disabled in this development version.');
  const provider = new KoiosProvider('preprod');
  const params = await provider.fetchProtocolParameters();
  const utxos = await wallet.getUtxos();
  const candidate = utxos.find(u => u.output.amount.length === 1 && u.output.amount[0].unit === 'lovelace' && BigInt(u.output.amount[0].quantity) >= 5000000n);
  if (!candidate) throw new Error('Need an ADA-only preprod UTxO with at least 5 test ADA');
  const verified = (await provider.fetchUTxOs(candidate.input.txHash, candidate.input.outputIndex))[0];
  if (!verified || verified.output.address !== candidate.output.address || JSON.stringify(verified.output.amount) !== JSON.stringify(candidate.output.amount)) throw new Error('Wallet UTxO is not on preprod');
  const address = await wallet.getChangeAddress();
  const hash = await computeCommitment(bundle);
  const unsigned = await new MeshTxBuilder({ fetcher: provider, params })
    .txOut(address, [{ unit: 'lovelace', quantity: '2000000' }])
    .metadataValue(LABEL, commitmentMetadata(bundle, hash))
    .changeAddress(address).selectUtxosFrom([verified]).complete();
  return { owner: verified.output.address, bytes: unsigned.length / 2,
    fee: Number(cst.Transaction.fromCbor(unsigned).body().fee()) / 1000000,
    async signAndSubmit(): Promise<string> {
      if (await wallet.getNetworkId() !== 0) throw new Error('Mainnet is disabled');
      const signed = await wallet.signTx(unsigned);
      const fee = Number(cst.Transaction.fromCbor(signed).body().fee());
      if (fee > 2 * (params.minFeeA * signed.length / 2 + params.minFeeB)) throw new Error('Fee exceeds twice the live protocol estimate');
      return provider.submitTx(signed);
    },
  };
}
