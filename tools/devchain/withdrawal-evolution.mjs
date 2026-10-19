// Plan step 9b spike item (3): the page's transaction path (Evolution SDK, the version in pnpm-lock.yaml, as called
// by apps/web/cardano.ts prepareTransaction) builds a commitment-shaped transaction that also carries a reward
// withdrawal, and the stake registration / DRep delegation it needs; a mock CIP-30 wallet (test keys, the same
// witness-set answer as tools/devchain/browser-live.mjs) signs; the trust-path reader re-reads the result; the
// signed bytes go to the real ledger (Yaci DevKit, withdrawal-yaci.mjs's devnet). Runs in Node, not in the page:
// the SDK calls are copied from prepareTransaction with `.withdraw(...)` added.
// Usage, with the devnet up: node tools/devchain/withdrawal-evolution.mjs > evolution-report.json
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkCommitmentTransaction,
  COMMITMENT_TRANSFER,
  commitmentValidUntil,
  encodeBech32,
  LABEL,
  preprodSlotAt,
  readCommitmentTransaction,
  roundAt,
  transactionHash,
  transactionParts,
} from '@giveaway/verifier-cli/library';
import { cbor, hex, sign, Tag, testKey, unhex } from '../../tests/cardano.mjs';

const STORE = process.env.YACI_STORE ?? 'http://127.0.0.1:18080/api/v1';
const SUBMIT = process.env.YACI_SUBMIT ?? 'http://127.0.0.1:18090';
const ADMIN = process.env.YACI_ADMIN ?? 'http://127.0.0.1:20000';
const log = (...args) => console.error(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The SDK is a dependency of apps/web only; load it from there.
const sdkRoot = dirname(
  createRequire(new URL('../../apps/web/package.json', import.meta.url)).resolve(
    '@evolution-sdk/evolution/package.json',
  ),
);
const sdk = (path) => import(pathToFileURL(join(sdkRoot, 'dist', `${path}.js`)).href);
const sdkVersion = createRequire(import.meta.url)(join(sdkRoot, 'package.json')).version;
const Address = await sdk('Address');
const Assets = await sdk('Assets');
const Credential = await sdk('Credential');
const DRep = await sdk('DRep');
const KeyHash = await sdk('KeyHash');
const Transaction = await sdk('Transaction');
const TransactionHash = await sdk('TransactionHash');
const TransactionInput = await sdk('TransactionInput');
const TransactionMetadatum = await sdk('TransactionMetadatum');
const { preprod } = await sdk('sdk/client/Chain');
const { makeTxBuilder } = await sdk('sdk/builders/TransactionBuilder');
const { BlockfrostProvider } = await sdk('sdk/provider/Blockfrost');

// A fresh identity per run (seeds overridable): registration only succeeds once per stake credential.
const payment = testKey(Number(process.env.EVO_PAYMENT_SEED ?? 10));
const stake = testKey(Number(process.env.EVO_STAKE_SEED ?? 11));
const addressHex = `00${payment.hash}${stake.hash}`;
const address = encodeBech32('addr_test', unhex(addressHex));
const stakeCredential = Credential.makeKeyHash(unhex(stake.hash));
const report = { sdk: `@evolution-sdk/evolution@${sdkVersion}`, address, steps: {} };

// Mock CIP-30 signTx: a witness set with vkey witnesses of the payment and stake keys over the body hash.
const mockSignTx = async (unsigned) => {
  const txId = unhex(transactionHash(unsigned));
  return hex(
    cbor(
      new Map([
        [
          0,
          new Tag(
            258,
            [payment, stake].map((k) => [k.publicKey, sign(k, txId)]),
          ),
        ],
      ]),
    ),
  );
};
async function submit(label, signedHex) {
  const response = await fetch(`${SUBMIT}/api/submit/tx`, {
    signal: AbortSignal.timeout(30_000),
    method: 'POST',
    headers: { 'Content-Type': 'application/cbor' },
    body: unhex(signedHex),
  });
  const body = await response.text();
  log('submit', label, response.status, body.slice(0, 300));
  return { status: response.status, body };
}
async function nodeUtxos() {
  const response = await fetch(`${ADMIN}/local-cluster/api/addresses/${address}/utxos`);
  return (await response.json()).filter((u) => u.amount.length === 1);
}
async function waitForUtxo(txHash) {
  for (let i = 0; i < 60; i++) {
    if ((await nodeUtxos()).some((u) => u.tx_hash === txHash)) return true;
    await sleep(1_000);
  }
  return false;
}
// Store indexing lags the node by a few blocks; the provider reads the Store.
async function storeHas(txHash) {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${STORE}/txs/${txHash}`);
    if (r.status === 200) return true;
    await sleep(1_000);
  }
  return false;
}

// Funding from the devnet faucet.
for (let attempt = 0; (await nodeUtxos()).length === 0 && attempt < 10; attempt++) {
  await fetch(`${ADMIN}/local-cluster/api/addresses/topup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, adaAmount: 1_000 }),
  });
  await sleep(3_000);
}
const provider = new BlockfrostProvider(STORE);
const params = await provider.getProtocolParameters();
report.params = {
  minFeeA: String(params.minFeeA),
  minFeeB: String(params.minFeeB),
  keyDeposit: String(params.keyDeposit),
};
const changeAddress = Address.fromHex(addressHex);
// The page reads the UTxO back through BlockfrostProvider.getUtxosByOutRef. Against Yaci Store 0.12.0 that call fails
// (its /txs/{h}/utxos outputs have no `collateral` field, which the SDK's schema requires; recorded in the report), so
// the UTxO is built from the node's answer (cluster admin API) with the SDK's own UTxO class.
const UTxO = await sdk('UTxO');
async function verifiedUtxo() {
  const [u] = (await nodeUtxos()).sort((x, y) =>
    BigInt(x.amount[0].quantity) > BigInt(y.amount[0].quantity) ? -1 : 1,
  );
  await storeHas(u.tx_hash);
  if (!report.providerOutRef) {
    try {
      await provider.getUtxosByOutRef([
        new TransactionInput.TransactionInput({
          transactionId: TransactionHash.fromHex(u.tx_hash),
          index: BigInt(u.output_index),
        }),
      ]);
      report.providerOutRef = 'ok';
    } catch (error) {
      // The parse error's detail is not reachable from the thrown FiberFailure; record the Store's output fields.
      const utxosBody = await (await fetch(`${STORE}/txs/${u.tx_hash}/utxos`)).json();
      report.providerOutRef = {
        error: String(error?.message ?? error),
        storeOutputFields: Object.keys(utxosBody.outputs?.[0] ?? {}),
        storeInputFields: Object.keys(utxosBody.inputs?.[0] ?? {}),
      };
    }
  }
  const verified = new UTxO.UTxO({
    transactionId: TransactionHash.fromHex(u.tx_hash),
    index: BigInt(u.output_index),
    address: Address.fromBech32(u.address),
    assets: Assets.fromLovelace(BigInt(u.amount[0].quantity)),
  });
  return { verified, txHash: u.tx_hash, index: u.output_index, lovelace: BigInt(u.amount[0].quantity) };
}
const bodyKeys = (txHex) => [...transactionParts(txHex).body.keys()].map(Number);
// Decoded CBOR (trust-path reader values) as JSON: bytes as hex, integers as strings, maps as [key, value] pairs.
const plain = (v) =>
  v instanceof Uint8Array
    ? hex(v)
    : typeof v === 'bigint'
      ? String(v)
      : v instanceof Map
        ? [...v].map(([k, x]) => [plain(k), plain(x)])
        : Array.isArray(v)
          ? v.map(plain)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
            : v;
const describe = (txHex) => {
  const body = transactionParts(txHex).body;
  const withdrawals = body.get(5);
  return {
    bodyKeys: bodyKeys(txHex),
    withdrawals: withdrawals ? plain(withdrawals) : null,
    certificates: body.get(4) ? plain(body.get(4)) : null,
    requiredSigners: body.get(14) ? plain(body.get(14)) : null,
    invalidHereafter: body.get(3) !== undefined ? plain(body.get(3)) : null,
  };
};
async function signAndSubmit(label, unsigned) {
  const witnessSet = await mockSignTx(unsigned);
  const signed = Transaction.addVKeyWitnessesHex(unsigned, witnessSet);
  const sameBody = transactionHash(signed) === transactionHash(unsigned);
  const fee = transactionParts(signed).body.get(2);
  const linear = BigInt(params.minFeeA) * BigInt(signed.length / 2) + BigInt(params.minFeeB);
  const result = await submit(label, signed);
  return {
    txHash: transactionHash(signed),
    sameBody,
    fee: String(fee),
    linearMinFeeOfSigned: String(linear),
    ...result,
  };
}

// 1. Registration and DRep delegation in one certificate, plus (separately) the same with a 0 ADA withdrawal.
{
  const u = await verifiedUtxo();
  const build = (withWithdrawal) => {
    let b = makeTxBuilder({ chain: preprod }).registerAndDelegateTo({ stakeCredential, drep: DRep.alwaysAbstain() });
    if (withWithdrawal) b = b.withdraw({ stakeCredential, amount: 0n });
    return b.build({ fullProtocolParameters: params, availableUtxos: [u.verified], changeAddress });
  };
  try {
    const sameTx = Transaction.toCBORHex(await (await build(true)).toTransaction());
    report.steps.registerDelegateWithdrawBuild = { built: true, ...describe(sameTx) };
  } catch (error) {
    report.steps.registerDelegateWithdrawBuild = { built: false, error: String(error?.message ?? error) };
  }
  const unsigned = Transaction.toCBORHex(await (await build(false)).toTransaction());
  report.steps.registerAndDelegate = {
    ...describe(unsigned),
    ...(await signAndSubmit('evolution: reg + vote deleg abstain', unsigned)),
  };
  report.steps.registerAndDelegate.included = await waitForUtxo(report.steps.registerAndDelegate.txHash);
}
// 2. The commitment, as prepareTransaction builds it, plus `.withdraw({ amount: 0n })`.
{
  const u = await verifiedUtxo();
  const metadata = { protocol: 'spike-9b', drawId: 'evolution', bundleHash: '00'.repeat(32), chainHash: 'x', round: 1 };
  const metadatum = (value) =>
    TransactionMetadatum.fromEntries(
      Object.entries(value).map(([k, v]) => [k, typeof v === 'number' ? TransactionMetadatum.int(BigInt(v)) : v]),
    );
  // A round one day ahead: its preprod-clock invalid_hereafter is far beyond the devnet's slot, so the ledger accepts it.
  const round = roundAt(Math.floor(Date.now() / 1000) + 86_400);
  const validUntil = commitmentValidUntil(round);
  const built = await makeTxBuilder({ chain: preprod })
    .payToAddress({ address: changeAddress, assets: Assets.fromLovelace(COMMITMENT_TRANSFER) })
    .attachMetadata({ label: BigInt(LABEL), metadata: metadatum(metadata) })
    .addSigner({ keyHash: KeyHash.fromHex(stake.hash) })
    .setValidity({ to: BigInt(validUntil) * 1000n })
    .withdraw({ stakeCredential, amount: 0n })
    .build({ fullProtocolParameters: params, availableUtxos: [u.verified], changeAddress });
  const unsigned = Transaction.toCBORHex(await built.toTransaction());
  const step = describe(unsigned);
  // Today's trust-path check (packages/chain checkCommitmentTransaction) still refuses body field 5: step 9b changes it.
  try {
    checkCommitmentTransaction(unsigned, {
      input: { txHash: u.txHash, index: u.index, lovelace: u.lovelace },
      address: addressHex,
      metadata,
      signer: stake.hash,
      invalidHereafter: preprodSlotAt(validUntil),
    });
    step.currentCheck = 'accepted';
  } catch (error) {
    step.currentCheck = `refused: ${error.message}`;
  }
  Object.assign(step, await signAndSubmit('evolution: commitment + 0 ADA withdrawal', unsigned));
  const signed = Transaction.addVKeyWitnessesHex(unsigned, await mockSignTx(unsigned));
  step.readerSigners = [...readCommitmentTransaction(signed, step.txHash).signers];
  step.included = await waitForUtxo(step.txHash);
  report.steps.commitmentWithWithdrawal = step;
}
console.log(JSON.stringify(report, null, 2));
