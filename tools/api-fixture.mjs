// Chain answers for the backend's upload-gate tests (apps/api/test), which run inside workerd and cannot read the
// recorded Dolos captures from disk. The transactions are built from the deterministic test keys (tests/cardano.mjs)
// and served by the shared Blockfrost-shaped mock (tests/blockfrost-mock.mjs: status codes, bodies and headers copied
// from Dolos 1.6.1); every request the real BlockfrostChain makes for the gate is recorded with its answer here, so
// the workerd tests replay what Node would see. `node tools/api-fixture.mjs` rewrites
// apps/api/test/chain-fixture.json; tests/core.test.mjs fails when that file differs from `generate()`.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ALGORITHM,
  BlockfrostChain,
  canonicalize,
  commitmentValidUntil,
  encodeBech32,
  FIXTURE,
  LABEL,
  preprodSlotAt,
  QUICKNET,
  roundTime,
  sha256,
  VERSION,
} from '@giveaway/verifier-cli/library';
import { blockfrostIndexer } from '../tests/blockfrost-mock.mjs';
import { buildTransaction, testKey, unhex } from '../tests/cardano.mjs';

export const INDEXER = 'https://indexer.test';
const R = FIXTURE.round;
const T = roundTime(R);
const wallet = (payment, stake) => {
  const hex = `00${payment.hash}${stake.hash}`;
  return { address: encodeBech32('addr_test', unhex(hex)), hex, keys: [payment, stake], stake };
};
// The organizer, another organizer who commits the same bundle hash in its own transaction (Amendment 2 of the
// wallet-auth ADR: anyone can), and an organizer with more commitments than the hosting quota.
const ORGANIZER = wallet(testKey(1), testKey(2));
const OTHER = wallet(testKey(4), testKey(5));
const BUSY = wallet(testKey(8), testKey(9));
const bundle = (drawId, entrants = ['alice', 'bob', 'carol'], round = R) => ({
  version: VERSION,
  algorithm: ALGORITHM,
  drawId,
  entrants,
  rules: { winners: 1 },
  drand: { chainHash: QUICKNET, round },
});
// A commitment transaction as the page builds it (stake key the only required signer, 0 ADA withdrawal from its reward
// account, invalid_hereafter before the round) of whatever bytes `text` is: the chain commits a hash, not a bundle.
// `round` is the metadata's round, which the organizer writes independently of the bundle's.
async function commit(from, text, drawId, n, round = R) {
  const metadata = { protocol: VERSION, drawId, bundleHash: await sha256(text), chainHash: QUICKNET, round };
  const built = buildTransaction({
    label: LABEL,
    metadata,
    signers: [from.stake.hash],
    witnesses: from.keys,
    invalidHereafter: preprodSlotAt(commitmentValidUntil(R)),
    input: await sha256(`api-fixture:${drawId}:${n}:${from.address}`),
    address: from.hex,
    withdrawals: [[`e0${from.stake.hash}`, 0n]],
  });
  return { ...built, label: LABEL, inputs: [from.address], metadata, blockHeight: 1000 + n, blockTime: T - 900 + n };
}

export async function generate() {
  const valid = canonicalize(bundle('hosted-1'));
  // Duplicate labels: validateBundle refuses it, yet its hash is committed on chain like any other bytes.
  const invalid = canonicalize(bundle('hosted-invalid', ['alice', 'alice']));
  const quota = canonicalize(bundle('hosted-quota'));
  // Bytes that pass validateBundle once parsed but are not the canonical serialization (the wallet-auth ADR hosts
  // canonical bundle bytes only), each committed on chain so only the canonical check can refuse them. A duplicate key:
  // JSON.parse keeps the last one, so the first can carry anything.
  const duplicateKey = canonicalize(bundle('hosted-duplicate')).replace(
    '"entrants":',
    `"entrants":"${'arbitrary content '.repeat(64)}","entrants":`,
  );
  const spaced = JSON.stringify(JSON.parse(canonicalize(bundle('hosted-spaced'))), null, 2);
  const reordered = JSON.stringify(bundle('hosted-reordered'));
  const bom = `\ufeff${canonicalize(bundle('hosted-bom'))}`;
  // A canonical bundle whose commitment names another round than its own (the metadata round is about a year later),
  // and one whose round is consistent but too far ahead for any representable expiry.
  const roundMismatch = canonicalize(bundle('hosted-round'));
  const farRound = canonicalize(bundle('hosted-far', undefined, Number.MAX_SAFE_INTEGER));
  const txs = {
    organizer: await commit(ORGANIZER, valid, 'hosted-1', 0),
    other: await commit(OTHER, valid, 'hosted-1', 1),
    invalid: await commit(ORGANIZER, invalid, 'hosted-invalid', 2),
    duplicateKey: await commit(ORGANIZER, duplicateKey, 'hosted-duplicate', 3),
    spaced: await commit(ORGANIZER, spaced, 'hosted-spaced', 4),
    reordered: await commit(ORGANIZER, reordered, 'hosted-reordered', 5),
    bom: await commit(ORGANIZER, bom, 'hosted-bom', 6),
    roundMismatch: await commit(ORGANIZER, roundMismatch, 'hosted-round', 7, R + 10_000_000),
    farRound: await commit(ORGANIZER, farRound, 'hosted-far', 8, Number.MAX_SAFE_INTEGER),
  };
  // One more than the 20 bundles an owner may keep hosted (BR-17).
  for (let i = 0; i < 21; i++) txs[`quota${i}`] = await commit(BUSY, quota, 'hosted-quota', 10 + i);
  const indexer = blockfrostIndexer({ txs: Object.values(txs) });
  const answers = {};
  const recording = async (url) => {
    const answer = indexer.answer('GET', url);
    answers[url.slice(INDEXER.length)] = { status: answer.status, headers: answer.headers, body: answer.body };
    return new Response(answer.body === '' ? null : answer.body, { status: answer.status, headers: answer.headers });
  };
  const chain = new BlockfrostChain(INDEXER, recording);
  // Exactly the reads the gate makes: the owner from the transaction, then the commitment for that owner.
  for (const tx of Object.values(txs)) await chain.readCommitment(tx.txHash, await chain.commitmentOwner(tx.txHash));
  const unknown = 'cd'.repeat(32);
  await chain.commitmentOwner(unknown).catch(() => {});
  return {
    generatedBy: 'tools/api-fixture.mjs',
    indexer: INDEXER,
    roundTime: T,
    bundles: { valid, invalid, quota, duplicateKey, spaced, reordered, bom, roundMismatch, farRound },
    owners: {
      organizer: encodeBech32('stake_test', unhex(`e0${ORGANIZER.stake.hash}`)),
      other: encodeBech32('stake_test', unhex(`e0${OTHER.stake.hash}`)),
      busy: encodeBech32('stake_test', unhex(`e0${BUSY.stake.hash}`)),
    },
    txs: { ...Object.fromEntries(Object.entries(txs).map(([name, tx]) => [name, tx.txHash])), unknown },
    answers,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = fileURLToPath(new URL('../apps/api/test/chain-fixture.json', import.meta.url));
  await writeFile(path, `${JSON.stringify(await generate(), null, 2)}\n`);
  console.log(`Wrote ${path}`);
}
