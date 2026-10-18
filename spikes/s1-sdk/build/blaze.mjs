import { Core, TxBuilder } from '@blaze-cardano/sdk';
export const name = 'blaze';
const toMetadatum = v => v instanceof Object ? new Map(Object.entries(v).map(([k, x]) => [k, toMetadatum(x)])) : typeof v === 'number' ? BigInt(v) : v;
export async function build(s) {
  const params = { ...Core.hardCodedProtocolParams, minFeeCoefficient: s.params.minFeeA, minFeeConstant: s.params.minFeeB,
    coinsPerUtxoByte: s.params.coinsPerUtxoByte, maxTxSize: s.params.maxTxSize };
  const address = Core.Address.fromBech32(s.addressBech32);
  const utxo = new Core.TransactionUnspentOutput(new Core.TransactionInput(Core.TransactionId(s.inputTxHash), BigInt(s.inputIndex)),
    new Core.TransactionOutput(address, new Core.Value(BigInt(s.lovelace))));
  const metadata = new Core.Metadata(new Map([[BigInt(s.label), Core.Metadatum.fromCore(toMetadatum(s.metadata))]]));
  const tx = await new TxBuilder(params)
    .setNetworkId(Core.NetworkId.Testnet)
    .addInput(utxo)
    .payLovelace(address, 2000000n)
    .setMetadata(metadata)
    .addRequiredSigner(Core.Ed25519KeyHashHex(s.stakeKeyHash))
    .setValidUntil(Core.Slot(s.ttlSlot))
    .setChangeAddress(address)
    .complete();
  return tx.toCbor();
}
