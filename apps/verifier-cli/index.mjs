#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  ARTIFACT_BYTE_LIMIT,
  BlockfrostChain,
  BUNDLE_BYTE_LIMIT,
  HISTORY_ROW_LIMIT,
  verifyBundle,
  verifyProof,
} from './dist/library.mjs';
const USAGE = [
  'Usage: node apps/verifier-cli/index.mjs <proof.json> --indexer <Blockfrost-compatible URL>',
  '   or: node apps/verifier-cli/index.mjs <drawId.bundle.json> --tx <commitment txHash> --indexer <Blockfrost-compatible URL>',
].join('\n');
// There is no project default (PD7): the verifier reads chain evidence only from a node its user chose.
const NODE_REQUIREMENTS = [
  '--indexer is required: name a Blockfrost-compatible indexer you trust, such as your own Dolos.',
  'It must be a full archive (not ledger-only or sliding history): a pruned node cannot list old commitments and the verifier cannot tell.',
  'It must record 0 ADA reward withdrawals in /accounts/{stake}/withdrawals (Dolos 1.6.1 does; db-sync needs ioShelley) and honour order=asc there.',
  `Its max_scan_items must be at least ${HISTORY_ROW_LIMIT + 100} (the Dolos default 3000 is enough).`,
  'Use https, or http only for a node on this machine.',
].join('\n');
const option = (args, name) => {
  const at = args.indexOf(name);
  return at < 0 || !args[at + 1] || args[at + 1].startsWith('--') ? undefined : args[at + 1];
};
// The whole command; exit code 0 for PASS or DEMO PASS, 1 for FAIL, 2 for a usage error. `chainFor` and `beacon` are
// replaced only by tests (an injected indexer and a recorded beacon); the CLI itself never contacts the backend (B1).
export async function main(
  args,
  { chainFor = (url) => new BlockfrostChain(url), beacon, out = console.log, err = console.error } = {},
) {
  const file = args[0];
  if (!file || file.startsWith('--')) {
    err(USAGE);
    return 2;
  }
  const indexer = option(args, '--indexer');
  if (!indexer) {
    err(`${USAGE}\n${NODE_REQUIREMENTS}`);
    return 2;
  }
  // Bundle mode (plan step 10): the canonical bundle bytes the organizer published and the commitment's txHash; the
  // owner is read from that transaction and the beacon from the drand relays.
  const bundleMode = args.includes('--tx');
  const tx = option(args, '--tx');
  if (bundleMode && !tx) {
    err(USAGE);
    return 2;
  }
  try {
    const chain = chainFor(indexer);
    const body = await readFile(file, 'utf8');
    const limit = bundleMode ? BUNDLE_BYTE_LIMIT : ARTIFACT_BYTE_LIMIT;
    if (Buffer.byteLength(body) > limit) throw new Error(`Bundle exceeds ${limit} bytes`);
    const verdict = bundleMode
      ? await verifyBundle(JSON.parse(body), tx, { chain, beacon })
      : await verifyProof(JSON.parse(body), { chain });
    out(JSON.stringify(verdict, null, 2));
    return verdict.status === 'FAIL' ? 1 : 0;
  } catch (e) {
    err(JSON.stringify({ status: 'FAIL', error: e.message }));
    return 1;
  }
}
// Run as a command, not when a test imports `main` (@giveaway/verifier-cli/cli).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = await main(process.argv.slice(2));
