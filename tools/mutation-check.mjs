import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION, ALGORITHM, QUICKNET, FIXTURE, DemoChain, selectWinners } from '../dist/library.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = { version: VERSION, algorithm: ALGORITHM, drawId: 'mutation-check', entrants: ['alice', 'bob', 'carol'],
  rules: { winners: 1 }, drand: { chainHash: QUICKNET, round: FIXTURE.round } };
const chain = new DemoChain(); const commitment = await chain.commit(bundle); chain.confirm(commitment);
const proof = { format: 'giveaway-proof-1', network: 'demo', bundle, commitment, beacon: FIXTURE,
  winners: await selectWinners(bundle, FIXTURE.randomness) };
const file = `${root}dist/mutation-proof.json`;
for (const [name, mutate] of [
  ['signature byte', x => { x.beacon.signature = x.beacon.signature.slice(0, -2) + '00'; }],
  ['committed entrant', x => { x.bundle.entrants[0] = 'mallory'; }],
  ['declared winner', x => { x.winners = ['mallory']; }],
]) {
  const changed = structuredClone(proof); mutate(changed); await writeFile(file, JSON.stringify(changed));
  const result = spawnSync(process.execPath, [`${root}apps/verifier-cli/index.mjs`, file], { encoding: 'utf8' });
  if (result.status !== 1 || JSON.parse(result.stdout).status !== 'FAIL') throw new Error(`Mutation not rejected: ${name}`);
  console.log(`Mutation rejected by CLI: ${name}`);
}
// A broken golden fixture must also make the actual test runner fail.
const library = await readFile(`${root}dist/library.mjs`, 'utf8');
const corrupted = library.replace(FIXTURE.signature, FIXTURE.signature.slice(0, -2) + '00');
if (corrupted === library) throw new Error('Signature fixture was not located');
await writeFile(`${root}dist/mutated-library.mjs`, corrupted);
const signatureTest = spawnSync(process.execPath, ['--test', '--test-name-pattern=real quicknet BLS', `${root}tests/core.test.mjs`], {
  encoding: 'utf8', env: { ...process.env, GIVEAWAY_LIBRARY: `${root}dist/mutated-library.mjs` },
});
if (signatureTest.status !== 1 || !signatureTest.stdout.includes('real quicknet BLS')) throw new Error('Signature mutation did not fail tests');
console.log('Signature byte mutation causes test failure');
const vectorPath = `${root}tests/vectors.json`, original = await readFile(vectorPath, 'utf8');
try {
  const vectors = JSON.parse(original); vectors[0].bundle.entrants[0] = 'mallory';
  await writeFile(vectorPath, JSON.stringify(vectors));
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=independent Python', `${root}tests/core.test.mjs`], { encoding: 'utf8' });
  if (result.status !== 1 || !result.stdout.includes('independent Python')) throw new Error('Golden mutation did not fail the test runner');
  console.log('Golden entrant mutation causes test failure');
} finally { await writeFile(vectorPath, original); }
