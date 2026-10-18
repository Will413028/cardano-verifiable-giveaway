// Mesh 1.9.1 (current dependency). Transaction parsing comes from @cardano-sdk/core through @meshsdk/core-cst.
import { resolveTxHash, checkSignature, cst } from '@meshsdk/core';

export const name = 'mesh';
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export const txHash = txHex => resolveTxHash(txHex);
export function auxHash(txHex) {
  const tx = cst.Transaction.fromCbor(cst.TxCBOR(txHex));
  const aux = tx.auxiliaryData();
  return { computed: aux ? cst.blake2b.hash(aux.toCbor(), 32) : null,
    declared: tx.body().auxiliaryDataHash() ?? null };
}
// checkSignature does not compare the protected-header address with the checked address; the header check is ours.
export async function verifyCose({ signature, key }, payloadHex, addressHex) {
  try {
    const header = cst.CoseSign1.fromCbor(signature).getAddress();
    if (hex(header) !== addressHex) return false;
    return await checkSignature(payloadHex, { signature, key }, cst.Address.fromBytes(cst.HexBlob(addressHex)).toBech32());
  } catch { return false; }
}
export async function verifyCoseUnwrapped({ signature, key }, payloadHex, addressHex) {
  try { return await checkSignature(payloadHex, { signature, key }, cst.Address.fromBytes(cst.HexBlob(addressHex)).toBech32()); } catch { return false; }
}
