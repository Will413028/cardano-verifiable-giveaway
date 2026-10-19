// Regenerates the `unsigned-evolution-withdrawal` fixture of tests/transactions.json: the unsigned commitment exactly as
// the page builds it (apps/web/cardano.ts prepareTransaction, Evolution SDK from the lockfile), bundled here for Node
// and run against a mock CIP-30 wallet and the Blockfrost mock of tests/blockfrost-mock.mjs (Dolos-recorded answers).
// The wallet's signTx receives the unsigned CBOR and refuses, so nothing is signed or sent. Usage, after `make build`:
//   node tools/unsigned-fixture.mjs            prints the entry
//   node tools/unsigned-fixture.mjs --write    also replaces it in tests/transactions.json
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  ALGORITHM,
  auxiliaryDataHash,
  encodeBech32,
  QUICKNET,
  transactionHash,
  VERSION,
} from '@giveaway/verifier-cli/library';
import { blockfrostIndexer } from '../tests/blockfrost-mock.mjs';
import { cbor, hex, unhex } from '../tests/cardano.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const NAME = 'unsigned-evolution-withdrawal';
// The organizer: base address with payment key hash 11…11 and stake key hash 22…22; a 25 ADA UTxO at output #3.
const ADDRESS = `00${'11'.repeat(28)}${'22'.repeat(28)}`;
const INPUT = { txHash: '3c'.repeat(32), index: 3, lovelace: 25_000_000 };
const STAKE = encodeBech32('stake_test', unhex(`e0${'22'.repeat(28)}`));
const BUNDLE = {
  version: VERSION,
  algorithm: ALGORITHM,
  drawId: '6f1c9a52-8d3e-4b7a-9c21-0e5d4f3a2b10',
  entrants: ['alice', 'bob'],
  rules: { winners: 1 },
  drand: { chainHash: QUICKNET, round: 1000400 },
};
const INDEXER = 'https://indexer.test';

const outfile = `${root}dist/unsigned-fixture-cardano.mjs`;
await build({
  entryPoints: [`${root}apps/web/cardano.ts`],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile,
  logLevel: 'warning',
});
// The project indexer: recorded Dolos answers; the organizer's stake account registered and delegated, reward balance
// 0 (ACCOUNT.delegated); the wallet's UTxO as /txs/{h}/utxos reports it.
const indexer = blockfrostIndexer({
  accounts: { [STAKE]: {} },
  fault: (path) =>
    path === `/txs/${INPUT.txHash}/utxos`
      ? {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            hash: INPUT.txHash,
            inputs: [],
            outputs: [0, 1, 2, 3].map((output_index) => ({
              address: encodeBech32('addr_test', unhex(ADDRESS)),
              amount: [{ unit: 'lovelace', quantity: String(INPUT.lovelace) }],
              output_index,
              data_hash: null,
              inline_datum: null,
              collateral: false,
              reference_script_hash: null,
              consumed_by_tx: null,
            })),
          }),
        }
      : undefined,
});
globalThis.fetch = async (input) => {
  const a = indexer.answer('GET', typeof input === 'string' ? input : input.url);
  return new Response(a.body === '' ? null : a.body, { status: a.status, headers: a.headers });
};
let unsigned;
// CIP-30 UTxO CBOR: [[tx id, index], [address, lovelace]].
const utxo = hex(
  cbor([
    [unhex(INPUT.txHash), INPUT.index],
    [unhex(ADDRESS), BigInt(INPUT.lovelace)],
  ]),
);
globalThis.window = {
  cardano: {
    mock: {
      name: 'Fixture wallet',
      icon: '',
      apiVersion: '1',
      enable: async () => ({
        getNetworkId: async () => 0,
        getChangeAddress: async () => ADDRESS,
        getUtxos: async () => [utxo],
        signTx: async (tx) => {
          unsigned = tx;
          throw new Error('fixture: not signed');
        },
        submitTx: async () => {
          throw new Error('fixture: not submitted');
        },
      }),
    },
  },
};
const { prepareTransaction } = await import(outfile);
const prepared = await prepareTransaction(BUNDLE, 'mock', INDEXER);
await prepared.signAndSubmit().catch((e) => {
  if (e.message !== 'fixture: not signed') throw e;
});
if (!unsigned) throw new Error('The page never asked the wallet to sign');
const entry = {
  name: NAME,
  source:
    'apps/web/cardano.ts with the Evolution SDK of pnpm-lock.yaml via tools/unsigned-fixture.mjs (base address 11../22.., 25 ADA input #3, dev chain parameters = preprod fee parameters, reward balance 0, round 1000400)',
  cbor: unsigned,
  txHash: transactionHash(unsigned),
  auxiliaryDataHash: auxiliaryDataHash(unsigned).computed,
};
console.log(JSON.stringify({ ...entry, fee: prepared.fee, calls: indexer.calls }, null, 2));
if (process.argv.includes('--write')) {
  const path = `${root}tests/transactions.json`;
  const fixtures = JSON.parse(await readFile(path, 'utf8'));
  const at = fixtures.findIndex((x) => x.name === NAME);
  if (at < 0) fixtures.push(entry);
  else fixtures[at] = entry;
  await writeFile(path, `${JSON.stringify(fixtures, null, 2)}\n`);
}
