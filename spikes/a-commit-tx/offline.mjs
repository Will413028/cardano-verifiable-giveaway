import { MeshTxBuilder, cst } from '@meshsdk/core';
import { commitmentMetadata, matchCommitment, LABEL } from './metadata.mjs';
import assert from 'node:assert/strict';
const address = cst.Address.fromBytes('60' + '00'.repeat(28)).toBech32();
const utxo = { input: { txHash: '00'.repeat(32), outputIndex: 0 },
  output: { address, amount: [{ unit: 'lovelace', quantity: '10000000' }] } };
const metadata = commitmentMetadata({ drawId: 'offline', bundleHash: 'ab'.repeat(32), round: 100 });
const txHex = await new MeshTxBuilder()
  .txOut(address, [{ unit: 'lovelace', quantity: '2000000' }])
  .metadataValue(LABEL, metadata).changeAddress(address).selectUtxosFrom([utxo]).complete();
const tx = cst.Transaction.fromCbor(txHex);
const blob = tx.auxiliaryData().toCore().blob.get(BigInt(LABEL));
const decoded = JSON.parse(JSON.stringify(Object.fromEntries(blob),
  (_, value) => typeof value === 'bigint' ? Number(value) : value));
assert.ok(matchCommitment(metadata, decoded));
assert.equal(matchCommitment(metadata, { ...decoded, bundleHash: 'ac' + decoded.bundleHash.slice(2) }), false);
assert.equal(tx.body().inputs().values().length, 1);
console.log(JSON.stringify({ scope: 'offline synthetic UTxO; no signing or submission',
  bytes: txHex.length / 2, feeLovelace: tx.body().fee().toString(),
  metadataRoundtrip: 'PASS', changedHash: 'REJECTED' }, null, 2));
