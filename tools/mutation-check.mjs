import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION, ALGORITHM, QUICKNET, FIXTURE, DemoChain, selectWinners } from '@giveaway/verifier-cli/library';
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = {
  version: VERSION,
  algorithm: ALGORITHM,
  drawId: 'mutation-check',
  entrants: ['alice', 'bob', 'carol'],
  rules: { winners: 1 },
  drand: { chainHash: QUICKNET, round: FIXTURE.round },
};
const ref = await new DemoChain().commit(bundle);
const proof = {
  format: 'giveaway-proof-2',
  network: 'demo',
  bundle,
  txHash: ref.txHash,
  owner: ref.owner,
  beacon: FIXTURE,
  winners: await selectWinners(bundle, FIXTURE.randomness),
};
const file = `${root}dist/mutation-proof.json`;
const cli = () => spawnSync(process.execPath, [`${root}apps/verifier-cli/index.mjs`, file], { encoding: 'utf8' });
// The unmutated proof must pass, or every mutation below would be "rejected" for the wrong reason.
await writeFile(file, JSON.stringify(proof));
const baseline = cli();
if (baseline.status !== 0 || JSON.parse(baseline.stdout).status !== 'DEMO PASS')
  throw new Error(`Unmutated proof does not pass: ${baseline.stdout}${baseline.stderr}`);
for (const [name, mutate] of [
  [
    'signature byte',
    (x) => {
      x.beacon.signature = `${x.beacon.signature.slice(0, -2)}00`;
    },
  ],
  [
    'committed entrant',
    (x) => {
      x.bundle.entrants[0] = 'mallory';
    },
  ],
  [
    'declared winner',
    (x) => {
      x.winners = ['mallory'];
    },
  ],
  [
    'embedded commitment',
    (x) => {
      x.commitment = { txHash: x.txHash, owner: x.owner };
    },
  ],
]) {
  const changed = structuredClone(proof);
  mutate(changed);
  await writeFile(file, JSON.stringify(changed));
  const result = cli();
  if (result.status !== 1 || JSON.parse(result.stdout).status !== 'FAIL')
    throw new Error(`Mutation not rejected: ${name}`);
  console.log(`Mutation rejected by CLI: ${name}`);
}
// Each mutation rewrites a file the test runner reads, runs the named test, and restores the file.
async function mustFail(name, path, mutate, testName) {
  const original = await readFile(path, 'utf8');
  const changed = mutate(original);
  if (changed === original) throw new Error(`${name}: mutation target was not located`);
  try {
    await writeFile(path, changed);
    const result = spawnSync(
      process.execPath,
      ['--test', `--test-name-pattern=${testName}`, `${root}tests/core.test.mjs`],
      {
        encoding: 'utf8',
      },
    );
    if (result.status !== 1 || !result.stdout.includes(testName)) throw new Error(`${name} did not fail the tests`);
    console.log(`${name} causes test failure`);
  } finally {
    await writeFile(path, original);
  }
}
const library = fileURLToPath(import.meta.resolve('@giveaway/verifier-cli/library'));
await mustFail(
  'Signature fixture mutation',
  library,
  (text) => text.replace(FIXTURE.signature, `${FIXTURE.signature.slice(0, -2)}00`),
  'real quicknet BLS',
);
await mustFail(
  'Removing the prime-order subgroup check',
  library,
  (text) =>
    text.replace(/if \(!this\.isTorsionFree\(\)\)\s*throw new Error\("bad point: not in prime-order subgroup"\);/, ''),
  'F6: fixture signature plus a G1 torsion point',
);
await mustFail(
  'Golden entrant mutation',
  `${root}tests/vectors.json`,
  (text) => {
    const vectors = JSON.parse(text);
    vectors[0].bundle.entrants[0] = 'mallory';
    return JSON.stringify(vectors);
  },
  'independent Python',
);
await mustFail(
  'Uniqueness conflict keyed on (address, drawId) instead of interval overlap',
  library,
  (text) =>
    text.replace(
      /x\.txHash !== target\.txHash && open\(x\) && x\.blockTime < roundTime\(target\.round\) && target\.blockTime < roundTime\(x\.round\)/,
      'x.txHash !== target.txHash && x.owner === target.owner && x.drawId === target.drawId',
    ),
  'F1 overlap: same wallet',
);
// Step 6: the page re-reads the SDK's unsigned transaction before signTx; dropping any field comparison must fail a test.
for (const [field, message, testName] of [
  ['input', 'Unsigned transaction spends an unexpected input', 'unsigned commitment re-read: input'],
  [
    'transfer output',
    'Unsigned transaction transfer output differs from the commitment',
    'unsigned commitment re-read: transfer output',
  ],
  [
    'change address',
    'Unsigned transaction sends change to another address',
    'unsigned commitment re-read: change address',
  ],
  ['balance', 'Unsigned transaction does not balance its input', 'unsigned commitment re-read: balance'],
  ['metadata', 'Unsigned transaction metadata differs from the commitment', 'unsigned commitment re-read: metadata'],
])
  await mustFail(
    `Skipping the unsigned ${field} comparison`,
    library,
    (text) => text.replace(`throw new Error("${message}")`, 'void 0'),
    testName,
  );
