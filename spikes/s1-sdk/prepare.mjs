// Builds fixtures/vectors.json from the downloaded preprod CBOR and test-only keys. Keys are derived from fixed
// strings inside this spike; they never held funds and are not personal wallet material.
import fs from 'node:fs';
import { sha256 } from '@noble/hashes/sha2.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import * as Evo from '@evolution-sdk/evolution';
import { SignData as EvoSignData } from '@evolution-sdk/evolution/cose';
import { signData as meshSignData, checkSignature as meshCheck, cst } from '@meshsdk/core';
import { read, fromHex, sigStructure, txParts } from './options/minimal.mjs';

const dir = new URL('./fixtures/', import.meta.url);
const hex = b => Buffer.from(b).toString('hex');
const seed = s => sha256(new TextEncoder().encode(`giveaway-spike-s1:${s}`));
const keyHash = pub => blake2b(pub, { dkLen: 28 });

// Transactions: original, one byte flipped in the body (last byte of the first input id), one byte flipped in aux.
function deriveCase(tx_hash, cbor, extra = {}) {
  const { bytes, body, bodyBytes, aux } = txParts(cbor);
  const bodyStart = bodyBytes.byteOffset - bytes.byteOffset;
  const inputs = body.get(0); const first = (inputs.tag === 258 ? inputs.value : inputs)[0][0];
  const at = bodyStart + hex(bodyBytes).indexOf(hex(first)) / 2 + 31;
  const mutatedBody = Uint8Array.from(bytes); mutatedBody[at] ^= 1;
  const auxStart = aux.byteOffset - bytes.byteOffset;
  // Last byte inside aux whose flip keeps the whole transaction well-formed (in practice a metadata text character).
  let mutatedAux;
  for (let i = aux.length - 1; i >= 0 && !mutatedAux; i--) {
    const m = Uint8Array.from(bytes); m[auxStart + i] ^= 1;
    try { const r = read(m); if (r.end === m.length) mutatedAux = m; } catch {}
  }
  read(mutatedBody); // stays well-formed CBOR
  return { txHash: tx_hash, cbor, mutatedBody: hex(mutatedBody), mutatedAux: hex(mutatedAux), declaredAux: hex(body.get(7)), ...extra };
}
const onChain = JSON.parse(fs.readFileSync(new URL('koios-tx_cbor.json', dir))).map(({ tx_hash, cbor }) => deriveCase(tx_hash, cbor));
// Synthetic (never on chain): the 3883c2a9 transaction with its aux data re-encoded non-canonically, body field 7
// updated in place to the hash of the new aux bytes. The ledger hashes the bytes as submitted, so a verifier must too.
function synthetic(source, label, rewriteAux) {
  const { bytes, bodyBytes, aux } = txParts(source.cbor);
  const newAux = rewriteAux(hex(aux));
  if (newAux === hex(aux)) throw new Error(`${label}: rewrite did not apply`);
  const newAuxHash = hex(blake2b(fromHex(newAux), { dkLen: 32 }));
  const newBody = hex(bodyBytes).replace(source.declaredAux, newAuxHash);
  const headerLen = bodyBytes.byteOffset - bytes.byteOffset;
  const middle = hex(bytes.subarray(headerLen + bodyBytes.length, aux.byteOffset - bytes.byteOffset));
  const cbor = hex(bytes.subarray(0, headerLen)) + newBody + middle + newAux;
  return deriveCase(hex(blake2b(fromHex(newBody), { dkLen: 32 })), cbor, { synthetic: label });
}
const src = onChain.find(t => t.txHash.startsWith('3883c2a9'));
const txs = [...onChain,
  // label 1 written as a two-byte uint (0x18 0x01) instead of 0x01
  synthetic(src, 'non-minimal metadata label', a => a.replace(/^d90103a100a101/, 'd90103a100a11801')),
  // inner metadata map written with indefinite length (0xbf ... 0xff) instead of 0xa2
  synthetic(src, 'indefinite-length metadata map', a => a.replace(/^d90103a100a101a2/, 'd90103a100a101bf') + 'ff')];

// Test keys and addresses (preprod network id 0).
const keys = Object.fromEntries(['payment', 'stake', 'attacker'].map(n => { const sk = seed(n); return [n, { sk, pub: ed25519.getPublicKey(sk) }]; }));
const base = Uint8Array.from([0x00, ...keyHash(keys.payment.pub), ...keyHash(keys.stake.pub)]);
const enterprise = Uint8Array.from([0x60, ...keyHash(keys.payment.pub)]);
const reward = Uint8Array.from([0xe0, ...keyHash(keys.stake.pub)]);
const attackerBase = Uint8Array.from([0x00, ...keyHash(keys.attacker.pub), ...keyHash(keys.stake.pub)]);

// Independent CIP-8 generator built from the RFC 9052 structure, not from any SDK under test.
const encMap = entries => { // small canonical-enough encoder for the header and COSE_Key maps used here
  const item = v => typeof v === 'number' ? (v >= 0 ? [v] : [0x20 | (-1 - v)]) : typeof v === 'string' ? [0x60 | v.length, ...new TextEncoder().encode(v)]
    : v instanceof Uint8Array ? (v.length < 24 ? [0x40 | v.length, ...v] : [0x58, v.length, ...v]) : (() => { throw new Error('type'); })();
  return Uint8Array.from([0xa0 | entries.length, ...entries.flatMap(([k, v]) => [...item(k), ...item(v)])]);
};
function nobleSign(sk, address, payload, { alg = -8 } = {}) {
  const prot = encMap([[1, alg], ['address', address]]);
  const sig = ed25519.sign(sigStructure(prot, payload), sk);
  const signature = Uint8Array.from([0x84, 0x58, prot.length, ...prot, 0xa1, 0x66, ...new TextEncoder().encode('hashed'), 0xf4, 0x58, payload.length, ...payload, 0x58, 64, ...sig]);
  const key = encMap([[1, 1], [3, -8], [-1, 6], [-2, ed25519.getPublicKey(sk)]]);
  return { signature: hex(signature), key: hex(key) };
}
const evoSign = (sk, address, payload) => {
  const r = EvoSignData.signData(hex(address), payload, Evo.PrivateKey.fromBytes(sk));
  return { signature: hex(r.signature), key: hex(r.key) };
};
// Mesh's ed25519 goes through libsodium; its exported entry points await sodium.ready only inside checkSignature.
await meshCheck('00', { key: '', signature: '' }).catch(() => {});
const meshSign = (sk, address, payload) => {
  const r = meshSignData(hex(payload), { address: cst.Address.fromBytes(hex(address)), key: cst.Ed25519PrivateKey.fromNormalBytes(sk) });
  return { signature: r.signature, key: r.key };
};

const payload = new TextEncoder().encode('giveaway-owner-op:{"op":"extend","txHash":"00"}');
const other = new TextEncoder().encode('giveaway-owner-op:{"op":"delete","txHash":"00"}');
const vectors = [];
for (const [gen, sign] of [['noble', nobleSign], ['evolution', evoSign], ['mesh', meshSign]]) {
  for (const [who, sk, addr] of [['base/payment', keys.payment.sk, base], ['reward/stake', keys.stake.sk, reward]]) {
    const s = sign(sk, addr, payload);
    vectors.push({ id: `${gen} ${who} valid`, ...s, payload: hex(payload), address: hex(addr), expect: true });
    vectors.push({ id: `${gen} ${who} other payload`, ...s, payload: hex(other), address: hex(addr), expect: false });
    const bad = fromHex(s.signature); bad[bad.length - 1] ^= 1;
    vectors.push({ id: `${gen} ${who} flipped signature`, signature: hex(bad), key: s.key, payload: hex(payload), address: hex(addr), expect: false });
  }
  // The attacker signs with its own key but names the organizer's base address in the protected header.
  vectors.push({ id: `${gen} attacker key claims organizer address`, ...sign(keys.attacker.sk, base, payload), payload: hex(payload), address: hex(base), expect: false });
  // Header names the base address; caller checks the enterprise address of the same payment key.
  vectors.push({ id: `${gen} header address differs from checked address`, ...sign(keys.payment.sk, base, payload), payload: hex(payload), address: hex(enterprise), expect: false });
}
// Structural negatives (noble generator only, since they need non-standard headers or bytes).
{
  const n = (id, v, expect = false) => vectors.push({ id: `noble ${id}`, payload: hex(payload), address: hex(base), expect, ...v });
  // Payment key signs for the reward address: credential mismatch.
  n('payment key signs reward address', { ...nobleSign(keys.payment.sk, reward, payload), address: hex(reward) });
  n('alg ES256 (-7) in protected header', nobleSign(keys.payment.sk, base, payload, { alg: -7 }));
  const t = nobleSign(keys.payment.sk, base, payload);
  n('trailing byte after COSE_Sign1', { ...t, signature: t.signature + '00' });
  // Embedded payload swapped for another of the same length; caller asks about the swapped payload.
  n('embedded payload altered, caller passes altered payload', { ...t, signature: t.signature.replace(hex(payload), hex(other)), payload: hex(other) });
  // hashed flag false but the embedded payload is blake2b-224(message): CIP-8 says the payload is the message itself.
  n('unflagged blake2b-224 payload', nobleSign(keys.payment.sk, base, blake2b(payload, { dkLen: 28 })));
}
const params = JSON.parse(fs.readFileSync(new URL('epoch-params.json', dir)))[0];
// One self-transfer commitment spec for every builder. Preprod slot/time: slot 86400 at 1655769600 s, 1 s slots
// (consistent with Koios tip abs_slot 136606087 at block_time 1792289287).
const buildSpec = { inputTxHash: 'c0'.repeat(32), inputIndex: 0, lovelace: '10000000', addressHex: hex(base),
  addressBech32: cst.Address.fromBytes(hex(base)).toBech32(), stakeKeyHash: hex(keyHash(keys.stake.pub)), ttlSlot: 136700000,
  slotConfig: { zeroTime: 1655769600000, zeroSlot: 86400, slotLength: 1000 },
  params: { epoch: params.epoch_no, minFeeA: params.min_fee_a, minFeeB: params.min_fee_b, coinsPerUtxoByte: Number(params.coins_per_utxo_size), maxTxSize: params.max_tx_size },
  label: 674, metadata: { protocol: 'development-2', drawId: 'spike-s1', bundleHash: 'ab'.repeat(32), chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971', round: 123456 } };
const out = { generated: 'prepare.mjs', txs, vectors, buildSpec,
  keys: { base: hex(base), reward: hex(reward), attackerBase: hex(attackerBase), paymentKeyHash: hex(keyHash(keys.payment.pub)), stakeKeyHash: hex(keyHash(keys.stake.pub)) } };
fs.writeFileSync(new URL('vectors.json', dir), JSON.stringify(out, null, 1));
console.log(`${txs.length} txs, ${vectors.length} COSE vectors`);
