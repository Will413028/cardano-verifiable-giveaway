// Drives the local Dolos emulator dev chain (tools/devchain/dolos.toml) with test keys only: wallets funded by the
// dev chain's Shelley genesis, balanced transactions built with tests/cardano.mjs, MiniBF reads that record every
// response. Plan step 8b; findings in docs/plans/2026-10-18-hardening-and-backend/spike-dolos.md.
import {
  commitmentMetadata,
  computeCommitment,
  encodeBech32,
  LABEL,
  transactionHash,
} from '@giveaway/verifier-cli/library';
import { buildTransaction, testKey, unhex } from '../../tests/cardano.mjs';

export const BASE = (process.env.DEVCHAIN_URL ?? 'http://127.0.0.1:3010').replace(/\/$/, '');
const key = (seed) => testKey(seed);
// Base addresses are 00 || payment || stake, enterprise addresses 60 || payment. Genesis (tools/devchain/shelley.json
// initialFunds) funds only the enterprise address of each payment key: Dolos 1.6.1 panics ("existing account",
// crates/cardano/src/model/accounts.rs:364) when a genesis UTxO at a base address is spent, because genesis creates no
// account for its stake credential. `fund` moves value from these to the base addresses with a transaction.
const base = (payment, stake) => ({ hex: `00${payment.hash}${stake.hash}`, keys: [payment, stake] });
const enterprise = (payment) => ({ hex: `60${payment.hash}`, keys: [payment] });
export const WALLETS = {
  organizer: base(key(1), key(2)),
  organizerSecond: base(key(6), key(2)),
  thirdParty: { hex: `00${key(3).hash}${key(2).hash}`, keys: [key(3)] },
  other: base(key(4), key(5)),
  enterprise: enterprise(key(7)),
};
export const GENESIS = { 1: enterprise(key(1)), 3: enterprise(key(3)), 4: enterprise(key(4)), 6: enterprise(key(6)) };
for (const wallet of [...Object.values(WALLETS), ...Object.values(GENESIS)])
  wallet.address = encodeBech32('addr_test', unhex(wallet.hex));
export const stakeAddress = (stakeHash) => encodeBech32('stake_test', unhex(`e0${stakeHash}`));
export const paymentCredential = (paymentHash) => encodeBech32('addr_vkh', unhex(paymentHash));

// Every MiniBF response is returned whole: status, the headers a browser would see, and the parsed or raw body.
export async function get(path) {
  const response = await fetch(`${BASE}${path}`);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}
export async function submit(cborHex) {
  const response = await fetch(`${BASE}/tx/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/cbor' },
    body: unhex(cborHex),
  });
  return { status: response.status, body: await response.text() };
}
export async function utxos(address) {
  const all = [];
  for (let page = 1; ; page++) {
    const { status, body } = await get(`/addresses/${address}/utxos?count=100&page=${page}`);
    if (status === 404) return all;
    if (status !== 200) throw new Error(`utxos ${status} ${JSON.stringify(body)}`);
    for (const u of body) {
      if (u.amount.length !== 1) continue;
      all.push({ txHash: u.tx_hash, index: u.output_index, lovelace: BigInt(u.amount[0].quantity) });
    }
    if (body.length < 100) return all;
  }
}
let params;
async function fees() {
  if (!params) {
    const { body } = await get('/epochs/latest/parameters');
    params = { a: BigInt(body.min_fee_a), b: BigInt(body.min_fee_b) };
  }
  return params;
}
// A balanced transaction spending `inputs` (from `from`), paying `outputs` ([address hex, lovelace]), returning the
// rest to `change` (default: `from`). Optional commitment-shaped parts: label metadata, required signers and
// invalid_hereafter. The fee is the linear minimum for the signed size plus a margin.
export async function build({
  from,
  inputs,
  outputs = [],
  change = from.hex,
  metadata = null,
  label = LABEL,
  signers = [],
  witnesses = from.keys,
  invalidHereafter = null,
}) {
  const { a, b } = await fees();
  const total = inputs.reduce((s, u) => s + u.lovelace, 0n);
  const paid = outputs.reduce((s, [, l]) => s + BigInt(l), 0n);
  let fee = 300_000n;
  for (let round = 0; round < 2; round++) {
    const tx = buildTransaction({
      label,
      metadata,
      signers,
      witnesses,
      invalidHereafter,
      inputs: inputs.map((u) => [u.txHash, u.index]),
      outputs: [...outputs, ...(change ? [[change, total - paid - fee]] : [])],
      fee,
    });
    const needed = a * BigInt(tx.cbor.length / 2) + b + 2_000n;
    if (round === 1 || needed === fee) return tx;
    fee = needed;
  }
}
export async function waitFor(txHash, { timeoutMs = 60_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { status, body } = await get(`/txs/${txHash}`);
    if (status === 200) return body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Transaction ${txHash} not included within ${timeoutMs} ms`);
}
// Splits the largest UTxO of `from` into `count` outputs of `each` lovelace to `to` (default: `from` itself).
export async function fanOut(from, count, each, to = from) {
  const [input] = (await utxos(from.address)).sort((x, y) => (x.lovelace > y.lovelace ? -1 : 1));
  const tx = await build({
    from,
    inputs: [input],
    outputs: Array.from({ length: count }, () => [to.hex, each]),
  });
  const result = await submit(tx.cbor);
  if (result.status !== 200) throw new Error(`fan-out rejected: ${result.status} ${result.body}`);
  await waitFor(tx.txHash);
  return tx.txHash;
}
// The metadata of a commitment to `bundle`, as the page writes it.
export async function commitment(bundle) {
  return commitmentMetadata(bundle, await computeCommitment(bundle));
}
export { transactionHash };
