// Plan step 9b spike item (2): the ledger rules W relies on, measured on a real Haskell ledger (cardano-node 11.0.1
// inside Yaci DevKit 0.12.0, protocol version 10, tools/devchain/yaci/compose.yml). Test keys only.
//   - organizer registers its stake (deposit) and delegates (pool + always-abstain DRep); a commitment-shaped
//     transaction with a 0 ADA withdrawal and the stake key witness is accepted;
//   - a third party's withdrawal for the organizer stake without (or with a forged) stake key witness is refused;
//   - a withdrawal for a registered stake without DRep delegation is refused;
//   - registration, DRep delegation and the withdrawal in one transaction;
//   - once the reward balance is non-zero: amounts other than the balance are refused, the full balance is accepted;
//   - what Yaci Store's Blockfrost-shaped /accounts/{stake}/withdrawals lists.
// Usage, with the devnet up (spike-withdrawal.md):
//   node tools/devchain/withdrawal-yaci.mjs > yaci-report.json
// Env: YACI_SUBMIT (default http://127.0.0.1:18090), YACI_STORE (http://127.0.0.1:18080/api/v1),
// YACI_ADMIN (http://127.0.0.1:20000), YACI_CONTAINER (cvg-9b-yaci), REWARD_WAIT_MS (default 1,500,000).
import { execFileSync } from 'node:child_process';
import { encodeBech32, LABEL } from '@giveaway/verifier-cli/library';
import { testKey, unhex } from '../../tests/cardano.mjs';
import { balanced, regCert, stakeVoteDelegAbstain, voteDelegAbstain } from './withdrawal-tx.mjs';

const SUBMIT = process.env.YACI_SUBMIT ?? 'http://127.0.0.1:18090';
const STORE = process.env.YACI_STORE ?? 'http://127.0.0.1:18080/api/v1';
const ADMIN = process.env.YACI_ADMIN ?? 'http://127.0.0.1:20000';
const CONTAINER = process.env.YACI_CONTAINER ?? 'cvg-9b-yaci';
const REWARD_WAIT_MS = Number(process.env.REWARD_WAIT_MS ?? 1_500_000);
const log = (...args) => console.error(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cli = (...args) =>
  execFileSync(
    'docker',
    [
      'exec',
      '-e',
      'CARDANO_NODE_SOCKET_PATH=/clusters/nodes/default/node/node.sock',
      CONTAINER,
      'cardano-cli',
      'conway',
      ...args,
      '--testnet-magic',
      '42',
    ],
    { encoding: 'utf8' },
  );
const tip = () => JSON.parse(cli('query', 'tip'));
const stakeInfo = (stake) => JSON.parse(cli('query', 'stake-address-info', '--address', stake));
const pparams = JSON.parse(cli('query', 'protocol-parameters'));

// Every request has a deadline and one retry: in the first run a submission never got an answer (the same bytes
// submitted again answered at once), which left the script waiting forever.
async function request(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (attempt === 1) throw error;
      log('retry', url, error.name);
    }
  }
}
async function json(url, init) {
  const response = await request(url, init);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body };
}
async function utxos(address) {
  const { status, body } = await json(`${ADMIN}/local-cluster/api/addresses/${address}/utxos`);
  if (status !== 200) throw new Error(`utxos ${status}`);
  return body
    .filter((u) => u.amount.length === 1)
    .map((u) => ({ txHash: u.tx_hash, index: u.output_index, lovelace: BigInt(u.amount[0].quantity) }));
}
// The faucet spends one UTxO per topup: back-to-back topups fail (HTTP 500) until the previous one is in a block, so
// each waits for its output and a failed one is retried.
async function topup(address, ada) {
  const before = (await utxos(address)).length;
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await json(`${ADMIN}/local-cluster/api/addresses/topup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, adaAmount: ada }),
    });
    if (r.body?.status) {
      while ((await utxos(address)).length <= before) await sleep(1_000);
      return;
    }
    await sleep(3_000);
  }
  throw new Error(`topup of ${address} failed`);
}
// cardano-submit-api: 202 with the tx id on success, 400 with the ledger's error otherwise.
async function submit(label, tx) {
  const response = await request(`${SUBMIT}/api/submit/tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/cbor' },
    body: unhex(tx.cbor),
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  const result = { label, txHash: tx.txHash, fee: tx.fee?.toString(), status: response.status, body };
  log('submit', label, response.status, text.slice(0, 300));
  return result;
}
// Inclusion is checked against the node: the transaction's first output appears in the UTxO set.
async function included(txHash, address, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await utxos(address)).some((u) => u.txHash === txHash)) return true;
    await sleep(1_000);
  }
  return false;
}

const key = (seed) => testKey(seed);
const base = (payment, stake) => {
  const hex = `00${payment.hash}${stake.hash}`;
  return { hex, address: encodeBech32('addr_test', unhex(hex)), payment, stake };
};
const stakeAddress = (stake) => encodeBech32('stake_test', unhex(`e0${stake.hash}`));
const organizer = base(key(1), key(2));
const noDrep = base(key(4), key(5));
const sameTx = base(key(6), key(7));
const thirdParty = { hex: `60${key(3).hash}`, payment: key(3) };
thirdParty.address = encodeBech32('addr_test', unhex(thirdParty.hex));
const fees = { a: BigInt(pparams.txFeePerByte), b: BigInt(pparams.txFeeFixed) };
const deposit = BigInt(pparams.stakeAddressDeposit);
// The devnet's only pool: the slot leader of every block (Yaci Store /blocks/latest slot_leader).
const pool = (await json(`${STORE}/blocks/latest`)).body.slot_leader;

const report = {
  node: execFileSync('docker', ['exec', CONTAINER, 'cardano-node', '--version'], { encoding: 'utf8' }).trim(),
  protocolVersion: pparams.protocolVersion,
  stakeAddressDeposit: pparams.stakeAddressDeposit,
  pool,
  tipAtStart: tip(),
  wallets: {
    organizer: { address: organizer.address, stake: stakeAddress(organizer.stake) },
    noDrep: { address: noDrep.address, stake: stakeAddress(noDrep.stake) },
    sameTx: { address: sameTx.address, stake: stakeAddress(sameTx.stake) },
    thirdParty: { address: thirdParty.address },
  },
  steps: {},
};

for (const [address, ada] of [
  [organizer.address, 10_000],
  [organizer.address, 10_000],
  [noDrep.address, 1_000],
  [sameTx.address, 1_000],
  [thirdParty.address, 1_000],
])
  await topup(address, ada);
await sleep(3_000);
const largest = async (address) => (await utxos(address)).sort((x, y) => (x.lovelace > y.lovelace ? -1 : 1))[0];
// Spends the wallet's largest UTxO (re-read every time, so change from an earlier step is reused).
const send = async (label, wallet, spec, extra = {}) => {
  const tx = balanced({ inputs: [await largest(wallet.address)], change: wallet.hex, ...spec }, { ...fees, ...extra });
  const result = await submit(label, tx);
  if (result.status === 202) result.included = await included(tx.txHash, wallet.address);
  return result;
};
const commitment = (drawId, amount) => ({
  outputs: [[organizer.hex, 2_000_000n]],
  metadata: { protocol: 'spike-9b', drawId },
  label: LABEL,
  signers: [organizer.stake.hash],
  invalidHereafter: tip().slot + 3_000,
  withdrawals: [[organizer.stake.hash, amount]],
  witnesses: [organizer.payment, organizer.stake],
});

// 1. Before registration.
report.steps.withdrawBeforeRegistration = await send(
  'organizer 0 ADA, stake not registered',
  organizer,
  commitment('pre', 0n),
);
// 2. Registration, DRep delegation and a 0 ADA withdrawal in the same transaction (another identity).
report.steps.registerDelegateWithdrawSameTx = await send(
  'stake 7: reg + vote deleg + 0 ADA withdrawal in one tx',
  sameTx,
  {
    certs: [regCert(sameTx.stake.hash, deposit), voteDelegAbstain(sameTx.stake.hash)],
    withdrawals: [[sameTx.stake.hash, 0n]],
    witnesses: [sameTx.payment, sameTx.stake],
  },
  { deposits: deposit },
);
report.steps.sameTxStakeInfo = stakeInfo(stakeAddress(sameTx.stake));
// 3. Organizer registers and delegates to the pool and to always-abstain.
report.steps.organizerRegisterAndDelegate = await send(
  'organizer: reg + stake/vote deleg (pool, abstain)',
  organizer,
  {
    certs: [regCert(organizer.stake.hash, deposit), stakeVoteDelegAbstain(organizer.stake.hash, pool)],
    witnesses: [organizer.payment, organizer.stake],
  },
  { deposits: deposit },
);
report.steps.organizerStakeInfoAfterRegistration = stakeInfo(stakeAddress(organizer.stake));
// 4. The commitment-shaped transaction with a 0 ADA withdrawal and the stake key witness.
report.steps.commitmentZeroWithdrawal = await send(
  'organizer commitment, 0 ADA withdrawal',
  organizer,
  commitment('w0', 0n),
);
// 5. Third party: a withdrawal for the organizer stake, its own inputs and witness only.
report.steps.thirdPartyNoStakeWitness = await send('third party, organizer stake, no stake witness', thirdParty, {
  withdrawals: [[organizer.stake.hash, 0n]],
  witnesses: [thirdParty.payment],
});
// 5b. Third party listing the organizer stake key as a required signer, still without its witness.
report.steps.thirdPartyRequiredSignerNoWitness = await send(
  'third party, organizer stake as required signer, no stake witness',
  thirdParty,
  { withdrawals: [[organizer.stake.hash, 0n]], signers: [organizer.stake.hash], witnesses: [thirdParty.payment] },
);
// 5c. Third party attaching a witness under the organizer stake public key with an invalid signature.
report.steps.thirdPartyForgedStakeWitness = await send('third party, forged organizer stake witness', thirdParty, {
  withdrawals: [[organizer.stake.hash, 0n]],
  witnesses: [thirdParty.payment, organizer.stake],
  corrupt: [organizer.stake],
});
// 6. Registered but no DRep delegation.
report.steps.noDrepRegister = await send(
  'stake 5: registration only',
  noDrep,
  { certs: [regCert(noDrep.stake.hash, deposit)], witnesses: [noDrep.payment, noDrep.stake] },
  { deposits: deposit },
);
report.steps.noDrepStakeInfo = stakeInfo(stakeAddress(noDrep.stake));
report.steps.noDrepZeroWithdrawal = await send('stake 5: 0 ADA withdrawal without DRep delegation', noDrep, {
  withdrawals: [[noDrep.stake.hash, 0n]],
  witnesses: [noDrep.payment, noDrep.stake],
});
// 6b. Same identity after delegating to always-abstain: the withdrawal goes through.
report.steps.noDrepDelegate = await send('stake 5: vote deleg abstain', noDrep, {
  certs: [voteDelegAbstain(noDrep.stake.hash)],
  witnesses: [noDrep.payment, noDrep.stake],
});
report.steps.noDrepZeroWithdrawalAfterDelegation = await send(
  'stake 5: 0 ADA withdrawal after DRep delegation',
  noDrep,
  {
    withdrawals: [[noDrep.stake.hash, 0n]],
    witnesses: [noDrep.payment, noDrep.stake],
  },
);

// 7. Non-zero reward balance (needs the organizer's delegation to reach a reward snapshot: a few epochs).
const started = Date.now();
let info = stakeInfo(stakeAddress(organizer.stake));
while (BigInt(info[0]?.rewardAccountBalance ?? 0) === 0n && Date.now() - started < REWARD_WAIT_MS) {
  await sleep(20_000);
  info = stakeInfo(stakeAddress(organizer.stake));
  log('reward balance', info[0]?.rewardAccountBalance, 'epoch', tip().epoch);
}
report.steps.rewardWait = { ms: Date.now() - started, info, tip: tip() };
const balance = BigInt(info[0]?.rewardAccountBalance ?? 0);
if (balance > 0n) {
  // Submit right after an epoch-boundary check so the balance cannot change in between.
  const steps = {};
  for (const [name, amount] of [
    ['zero', 0n],
    ['balanceMinusOne', balance - 1n],
    ['balancePlusOne', balance + 1n],
  ]) {
    const now = stakeInfo(stakeAddress(organizer.stake))[0].rewardAccountBalance;
    steps[name] = {
      balanceBefore: now,
      ...(await send(`organizer withdrawal ${amount}, balance ${now}`, organizer, commitment(`nz-${name}`, amount))),
    };
  }
  const now = BigInt(stakeInfo(stakeAddress(organizer.stake))[0].rewardAccountBalance);
  steps.fullBalance = {
    balanceBefore: now.toString(),
    ...(await send(`organizer withdrawal full ${now}`, organizer, commitment('nz-full', now))),
  };
  steps.after = stakeInfo(stakeAddress(organizer.stake));
  steps.tip = tip();
  report.steps.nonZero = steps;
} else report.steps.nonZero = { measured: false, reason: `reward balance still 0 after ${REWARD_WAIT_MS} ms` };

// 8. Yaci Store's Blockfrost-shaped listing (give it a few blocks to index).
await sleep(10_000);
const stake = stakeAddress(organizer.stake);
report.store = {
  withdrawalsAsc: await json(`${STORE}/accounts/${stake}/withdrawals?order=asc&count=100&page=1`),
  withdrawalsDesc: await json(`${STORE}/accounts/${stake}/withdrawals?order=desc&count=100&page=1`),
  withdrawalsCount1Page2: await json(`${STORE}/accounts/${stake}/withdrawals?order=asc&count=1&page=2`),
  withdrawalsFromTo: await json(`${STORE}/accounts/${stake}/withdrawals?from=1&to=2`),
  noDrepWithdrawals: await json(`${STORE}/accounts/${stakeAddress(noDrep.stake)}/withdrawals`),
  unknownStake: await json(`${STORE}/accounts/${stakeAddress(key(9))}/withdrawals`),
  account: await json(`${STORE}/accounts/${stake}`),
  txWithdrawals: await json(`${STORE}/txs/${report.steps.commitmentZeroWithdrawal.txHash}/withdrawals`),
};
report.tipAtEnd = tip();
console.log(JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
