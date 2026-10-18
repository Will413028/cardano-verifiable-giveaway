import { MeshTxBuilder, DEFAULT_PROTOCOL_PARAMETERS } from '@meshsdk/core';
export const name = 'mesh';
export async function build(s) {
  const params = { ...DEFAULT_PROTOCOL_PARAMETERS, epoch: s.params.epoch, minFeeA: s.params.minFeeA, minFeeB: s.params.minFeeB,
    coinsPerUtxoSize: s.params.coinsPerUtxoByte, maxTxSize: s.params.maxTxSize };
  return new MeshTxBuilder({ params })
    .txIn(s.inputTxHash, s.inputIndex, [{ unit: 'lovelace', quantity: s.lovelace }], s.addressBech32, 0)
    .txOut(s.addressBech32, [{ unit: 'lovelace', quantity: '2000000' }])
    .metadataValue(s.label, s.metadata)
    .requiredSignerHash(s.stakeKeyHash)
    .invalidHereafter(s.ttlSlot)
    .changeAddress(s.addressBech32)
    .complete();
}
