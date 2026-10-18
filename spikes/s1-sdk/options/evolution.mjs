// Evolution SDK. Body bytes must be re-emitted with the decoded format tree; TransactionBody.toHash(body) re-encodes.
import { Transaction, TransactionBody, TransactionHash, AuxiliaryData, AuxiliaryDataHash, CBOR } from '@evolution-sdk/evolution';
import { blake2b } from '@noble/hashes/blake2.js'; // already an Evolution dependency
import { SignData } from '@evolution-sdk/evolution/cose';

export const name = 'evolution';
const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
export function txHash(txHex) {
  const { value, format } = Transaction.fromCBORHexWithFormat(txHex);
  return TransactionHash.toHex(TransactionBody.toHashFromBytes(TransactionBody.toCBORBytesWithFormat(value.body, format.children[0])));
}
// The naive API path, recorded separately because it is the one a reader of the docs reaches first.
export function txHashNaive(txHex) { return TransactionHash.toHex(TransactionBody.toHash(Transaction.fromCBORHex(txHex).body)); }
// AuxiliaryData.toHash re-encodes, so the raw aux bytes are cut out with CBOR.decodeItemWithOffset instead.
export function auxHash(txHex) {
  const bytes = Uint8Array.from(txHex.match(/../g), x => parseInt(x, 16));
  if (bytes[0] !== 0x84) throw new Error('expected a 4-element transaction array');
  let off = 1; const spans = [];
  for (let i = 0; i < 4; i++) { const { newOffset } = CBOR.decodeItemWithOffset(bytes, off); spans.push([off, newOffset]); off = newOffset; }
  if (off !== bytes.length) throw new Error('trailing bytes');
  const tx = Transaction.fromCBORHex(txHex); const aux = bytes.subarray(...spans[3]);
  return { computed: aux.length === 1 && aux[0] === 0xf6 ? null : hex(blake2b(aux, { dkLen: 32 })),
    declared: tx.body.auxiliaryDataHash ? AuxiliaryDataHash.toHex(tx.body.auxiliaryDataHash) : null };
}
export function auxHashNaive(txHex) {
  const tx = Transaction.fromCBORHex(txHex);
  return { computed: tx.auxiliaryData ? AuxiliaryDataHash.toHex(AuxiliaryData.toHash(tx.auxiliaryData)) : null,
    declared: tx.body.auxiliaryDataHash ? AuxiliaryDataHash.toHex(tx.body.auxiliaryDataHash) : null };
}
// verifyData checks payload, header address, EdDSA, key hash and address binding itself; the key hash argument
// is the address's signing credential (payment for base/enterprise, stake for reward), read from the header byte.
export function verifyCose({ signature, key }, payloadHex, addressHex) {
  const a = Uint8Array.from(addressHex.match(/../g), x => parseInt(x, 16));
  return SignData.verifyData(addressHex, hex(a.subarray(1, 29)), Uint8Array.from(payloadHex.match(/../g) ?? [], x => parseInt(x, 16)),
    { signature: Uint8Array.from(signature.match(/../g), x => parseInt(x, 16)), key: Uint8Array.from(key.match(/../g), x => parseInt(x, 16)) });
}
