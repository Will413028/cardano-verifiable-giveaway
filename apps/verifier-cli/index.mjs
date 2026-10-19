#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { ARTIFACT_BYTE_LIMIT, BlockfrostChain, HISTORY_ROW_LIMIT, verifyProof } from './dist/library.mjs';
const USAGE = 'Usage: node apps/verifier-cli/index.mjs <proof.json> --indexer <Blockfrost-compatible URL>';
// There is no project default (PD7): the verifier reads chain evidence only from a node its user chose.
const NODE_REQUIREMENTS = [
  '--indexer is required: name a Blockfrost-compatible indexer you trust, such as your own Dolos.',
  'It must be a full archive (not ledger-only or sliding history): a pruned node cannot list old commitments and the verifier cannot tell.',
  'It must record 0 ADA reward withdrawals in /accounts/{stake}/withdrawals (Dolos 1.6.1 does; db-sync needs ioShelley) and honour order=asc there.',
  `Its max_scan_items must be at least ${HISTORY_ROW_LIMIT + 100} (the Dolos default 3000 is enough).`,
  'Use https, or http only for a node on this machine.',
].join('\n');
const args = process.argv.slice(2);
const file = args[0];
const index = args.indexOf('--indexer');
if (!file || file.startsWith('--')) {
  console.error(USAGE);
  process.exit(2);
}
if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {
  console.error(`${USAGE}\n${NODE_REQUIREMENTS}`);
  process.exit(2);
}
try {
  const chain = new BlockfrostChain(args[index + 1]);
  const body = await readFile(file, 'utf8');
  if (Buffer.byteLength(body) > ARTIFACT_BYTE_LIMIT) throw new Error(`Bundle exceeds ${ARTIFACT_BYTE_LIMIT} bytes`);
  const verdict = await verifyProof(JSON.parse(body), { chain });
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = verdict.status === 'FAIL' ? 1 : 0;
} catch (e) {
  console.error(JSON.stringify({ status: 'FAIL', error: e.message }));
  process.exitCode = 1;
}
