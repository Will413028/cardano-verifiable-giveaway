// Plan step 9b spike: Conway transactions with stake certificates and reward withdrawals, built from the test-only
// CBOR encoder and Ed25519 test keys of tests/cardano.mjs (no wallet, no SDK). Used by withdrawal-spike.mjs (Dolos
// emulator) and withdrawal-yaci.mjs (Yaci DevKit, real Haskell ledger). Encodings follow the Conway CDDL
// (cardano-ledger eras/conway/impl/cddl-files/conway.cddl): certificates are body key 4, withdrawals body key 5
// ({reward_account => coin}), required_signers body key 14.
import { blake2b } from '@noble/hashes/blake2.js';
import { cbor, hex, Raw, sign, Tag, unhex } from '../../tests/cardano.mjs';

// A testnet reward account (CIP-19 header 0xe0: key-hash stake credential, network 0).
export const rewardAccount = (stakeHash) => `e0${stakeHash}`;
const credential = (stakeHash) => [0, unhex(stakeHash)];
// reg_cert = (7, stake_credential, coin): Conway registration that states the deposit.
export const regCert = (stakeHash, deposit) => [7, credential(stakeHash), BigInt(deposit)];
// unreg_cert = (8, stake_credential, coin)
export const unregCert = (stakeHash, deposit) => [8, credential(stakeHash), BigInt(deposit)];
// vote_deleg_cert = (9, stake_credential, drep); drep [2] = always abstain.
export const voteDelegAbstain = (stakeHash) => [9, credential(stakeHash), [2]];
// stake_vote_deleg_cert = (10, stake_credential, pool_keyhash, drep)
export const stakeVoteDelegAbstain = (stakeHash, poolHash) => [10, credential(stakeHash), unhex(poolHash), [2]];

// A signed Conway transaction. `withdrawals` is [[stakeHash, lovelace]], `certs` is a list of the certificate arrays
// above, `witnesses` the keys that sign the body hash. `corrupt` flips a bit in the signature of those keys.
export function buildStakeTx({
  inputs,
  outputs,
  fee,
  certs = [],
  withdrawals = [],
  metadata = null,
  label = null,
  signers = [],
  witnesses = [],
  corrupt = [],
  invalidHereafter = null,
}) {
  const set = (items) => new Tag(258, items);
  const auxiliary = metadata
    ? cbor(
        new Tag(
          259,
          new Map([
            [
              0,
              new Map([
                [
                  BigInt(label),
                  new Map(Object.entries(metadata).map(([k, v]) => [k, typeof v === 'number' ? BigInt(v) : v])),
                ],
              ]),
            ],
          ]),
        ),
      )
    : null;
  const body = new Map([
    [0, set(inputs.map(([id, index]) => [unhex(id), index]))],
    [1, outputs.map(([to, lovelace]) => [unhex(to), BigInt(lovelace)])],
    [2, BigInt(fee)],
  ]);
  if (invalidHereafter !== null) body.set(3, BigInt(invalidHereafter));
  if (certs.length) body.set(4, set(certs));
  if (withdrawals.length)
    body.set(5, new Map(withdrawals.map(([stake, amount]) => [unhex(rewardAccount(stake)), BigInt(amount)])));
  if (auxiliary) body.set(7, blake2b(auxiliary, { dkLen: 32 }));
  if (signers.length) body.set(14, set(signers.map(unhex)));
  const bodyBytes = cbor(body);
  const txId = blake2b(bodyBytes, { dkLen: 32 });
  const vkeys = witnesses.map((key) => {
    const signature = sign(key, txId);
    if (corrupt.includes(key)) signature[0] ^= 1;
    return [key.publicKey, signature];
  });
  const witnessSet = new Map(vkeys.length ? [[0, set(vkeys)]] : []);
  const tx = cbor([new Raw(bodyBytes), witnessSet, true, auxiliary ? new Raw(auxiliary) : null]);
  return { txHash: hex(txId), cbor: hex(tx), size: tx.length };
}

// Balances `spec` (inputs given with their lovelace) for the linear fee: inputs + withdrawals + refunds = outputs +
// change + fee + deposits. `deposits` and `refunds` are the net lovelace the certificates lock or release.
// `pallasRule` balances the way pallas-validate 1.3.0 checks Conway value preservation (inputs = outputs + fee,
// phase1/conway.rs check_preservation_of_value: withdrawals and deposits are not counted), which is what the Dolos
// emulator mempool accepts; a real ledger refuses such a transaction whenever a withdrawal or deposit is non-zero.
export function balanced(spec, { a, b, deposits = 0n, refunds = 0n, margin = 2_000n, pallasRule = false }) {
  const total = spec.inputs.reduce((s, u) => s + u.lovelace, 0n);
  const withdrawn = pallasRule ? 0n : (spec.withdrawals ?? []).reduce((s, [, l]) => s + BigInt(l), 0n);
  if (pallasRule) [deposits, refunds] = [0n, 0n];
  const paid = (spec.outputs ?? []).reduce((s, [, l]) => s + BigInt(l), 0n);
  let fee = 400_000n;
  for (let round = 0; round < 3; round++) {
    const tx = buildStakeTx({
      ...spec,
      inputs: spec.inputs.map((u) => [u.txHash, u.index]),
      outputs: [...(spec.outputs ?? []), [spec.change, total + withdrawn + refunds - paid - deposits - fee]],
      fee,
    });
    const needed = a * BigInt(tx.size) + b + margin;
    if (needed === fee || round === 2) return { ...tx, fee };
    fee = needed;
  }
}
