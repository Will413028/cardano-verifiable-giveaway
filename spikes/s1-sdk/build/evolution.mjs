import * as Evo from '@evolution-sdk/evolution';
import { makeTxBuilder } from '@evolution-sdk/evolution/sdk/builders/TransactionBuilder';
export const name = 'evolution';
const toMetadatum = v => v instanceof Object ? Evo.TransactionMetadatum.fromEntries(Object.entries(v).map(([k, x]) => [k, toMetadatum(x)])) : typeof v === 'number' ? BigInt(v) : v;
export async function build(s) {
  const address = Evo.Address.fromBech32(s.addressBech32);
  const utxo = new Evo.UTxO.UTxO({ transactionId: Evo.TransactionHash.fromHex(s.inputTxHash), index: BigInt(s.inputIndex), address, assets: Evo.Assets.fromLovelace(BigInt(s.lovelace)) });
  const chain = Evo.preprod; // its slotConfig equals s.slotConfig (zeroTime 1655769600000n, zeroSlot 86400n, 1000 ms)
  // Validity is expressed as Unix time and converted through chain.slotConfig; the slot is mapped back here.
  const to = BigInt(s.slotConfig.zeroTime + (s.ttlSlot - s.slotConfig.zeroSlot) * s.slotConfig.slotLength);
  const tx = await makeTxBuilder({ chain })
    .payToAddress({ address, assets: Evo.Assets.fromLovelace(2000000n) })
    .attachMetadata({ label: BigInt(s.label), metadata: toMetadatum(s.metadata) })
    .addSigner({ keyHash: Evo.KeyHash.fromHex(s.stakeKeyHash) })
    .setValidity({ to })
    .build({ protocolParameters: { minFeeCoefficient: BigInt(s.params.minFeeA), minFeeConstant: BigInt(s.params.minFeeB),
      coinsPerUtxoByte: BigInt(s.params.coinsPerUtxoByte), maxTxSize: s.params.maxTxSize }, availableUtxos: [utxo], changeAddress: address });
  const unsigned = await tx.toTransaction();
  return Evo.Transaction.toCBORHex(unsigned);
}
