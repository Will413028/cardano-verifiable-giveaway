#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { verifyProof, KoiosChain } from './dist/library.mjs';
const args = process.argv.slice(2);
const file = args[0];
if (!file || file.startsWith('--')) {
  console.error('Usage: node apps/verifier-cli/index.mjs <proof.json> [--indexer https://host/api/v1]');
  process.exit(2);
}
try {
  const index = args.indexOf('--indexer');
  if (index >= 0 && !args[index + 1]) throw new Error('Missing indexer URL');
  const body = await readFile(file, 'utf8');
  if (Buffer.byteLength(body) > 8_000_000) throw new Error('Bundle exceeds 8 MB');
  const verdict = await verifyProof(JSON.parse(body), index >= 0 ? { chain: new KoiosChain(args[index + 1]) } : {});
  console.log(JSON.stringify(verdict, null, 2));
  process.exitCode = verdict.status === 'FAIL' ? 1 : 0;
} catch (e) {
  console.error(JSON.stringify({ status: 'FAIL', error: e.message }));
  process.exitCode = 1;
}
