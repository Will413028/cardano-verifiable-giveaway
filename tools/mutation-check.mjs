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
// --indexer is always required (PD7); a demo proof never reads it, and .invalid never resolves.
const cli = () =>
  spawnSync(process.execPath, [`${root}apps/verifier-cli/index.mjs`, file, '--indexer', 'https://indexer.invalid'], {
    encoding: 'utf8',
  });
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
async function mustFail(name, path, mutate, testName, testFile = `${root}tests/core.test.mjs`) {
  const original = await readFile(path, 'utf8');
  const changed = mutate(original);
  if (changed === original) throw new Error(`${name}: mutation target was not located`);
  try {
    await writeFile(path, changed);
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${testName}`, testFile], {
      encoding: 'utf8',
    });
    if (result.status !== 1 || !result.stdout.includes(testName)) throw new Error(`${name} did not fail the tests`);
    // The first failure line the runner printed, so the reason is visible next to the mutation.
    const lines = result.stdout.split('\n');
    const at = lines.findIndex((line) => /Error/.test(line));
    const reason =
      at < 0
        ? ''
        : lines
            .slice(at, at + 6)
            .map((line) => line.trim())
            .filter(Boolean)
            .join(' ');
    console.log(`${name} causes test failure${reason ? ` (${reason.slice(0, 240)})` : ''}`);
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
  [
    'required signers',
    'Unsigned transaction required signers differ from the organizer identity',
    'unsigned commitment re-read: required signers',
  ],
  [
    'validity upper bound',
    'Unsigned transaction validity upper bound differs from the commitment',
    'unsigned commitment re-read: validity upper bound',
  ],
])
  await mustFail(
    `Skipping the unsigned ${field} comparison`,
    library,
    (text) => text.replace(`throw new Error("${message}")`, 'void 0'),
    testName,
  );
// Step 7: the verifier reads commitments from the transaction CBOR; skipping any of its three checks must fail a test.
await mustFail(
  'Skipping the auxiliary data hash comparison',
  library,
  (text) =>
    text.replace(
      'if (auxHash.computed !== auxHash.declared) throw new Error("Transaction auxiliary data hash mismatch");',
      '',
    ),
  'F2: auxiliary data replaced',
);
await mustFail(
  'Skipping the vkey witness signature verification',
  library,
  (text) => text.replace('required.has(keyHash) && ed25519Verify(signature, message, vkey)', 'required.has(keyHash)'),
  'PD3 witness',
);
await mustFail(
  'Skipping the validity upper bound check',
  library,
  (text) => text.replace('return checkValidityBound(commitment, round) && ', 'return '),
  'F17: invalid_hereafter',
);
// Step 8b: the Blockfrost-shaped adapter (PD7, PD9). One guard per mutation, each against the test written for it.
await mustFail(
  'CLI falling back to a default indexer',
  `${root}apps/verifier-cli/index.mjs`,
  (text) =>
    text
      .replace("if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) {", 'if (false) {')
      .replace(
        'new BlockfrostChain(args[index + 1])',
        "new BlockfrostChain(index < 0 ? 'http://127.0.0.1:3010' : args[index + 1])",
      ),
  'CLI requires --indexer',
);
await mustFail(
  'Enumerating only the first page of each address',
  library,
  (text) => text.replace('if (listed.length < PAGE) break;', 'break;'),
  'a conflicting commitment on the second page',
);
await mustFail(
  'Taking a max_scan_items 400 as the end of a list',
  library,
  (text) =>
    text.replace(
      'const rows = await this.json(at, answer);',
      'const rows = answer.status === 400 && answer.body.includes("scan limit") ? [] : await this.json(at, answer);',
    ),
  'a scan-limit 400 is never the end of a list',
);
await mustFail(
  'Skipping an enumerated transaction whose CBOR is not served',
  library,
  (text) =>
    text.replace(
      'if (raw.status === 404) throw new Error("Organizer history transaction evidence is incomplete");',
      'if (raw.status === 404) continue;',
    ),
  'an enumerated commitment whose CBOR is not served',
);
await mustFail(
  'Taking a non-2xx answer for one address as an empty list',
  library,
  (text) => text.replace(/(const listed = await this\.page\([^;]*\));/, '$1.catch(() => []);'),
  'any non-2xx answer for one of the identity addresses',
);
await mustFail(
  'Counting the enumeration limit per address instead of summed',
  library,
  (text) => text.replace('for (const address of lists) {', 'for (const address of lists) { enumerated = 0;'),
  'history over L enumerated rows fails',
);
await mustFail(
  'Merging the address lists without tx_hash deduplication',
  library,
  (text) => text.replace('rows.set(row.tx_hash, row);', 'rows.set(address + row.tx_hash, row);'),
  'one transaction listed under several identity addresses',
);
// The reverse proxy in front of the project Dolos (plan step 9, PD8 A): each guard of the committed config, removed
// alone, fails its static check. tools/devchain/rproxy-check.mjs removes the same guards in a live nginx.
const proxyConfig = `${root}deploy/dolos-proxy/nginx.conf`;
await mustFail(
  'Opening the reverse proxy allowlist',
  proxyConfig,
  (text) => text.replace('map $uri $route {\n    default "";', 'map $uri $route {\n    default any;'),
  'reverse proxy allowlist admits',
);
await mustFail(
  'Removing the reverse proxy rate limit',
  proxyConfig,
  (text) => text.replace('      limit_req zone=dolos_ip burst=350 delay=300;\n', ''),
  'reverse proxy limits every client',
);
await mustFail(
  'Allowing every origin at the reverse proxy',
  proxyConfig,
  (text) => text.replace('default refused;', 'default allowed;'),
  'reverse proxy limits every client',
);
await mustFail(
  'Logging the request line at the reverse proxy',
  proxyConfig,
  (text) =>
    text.replace("log_format giveaway '$time_iso8601", 'log_format giveaway \'$remote_addr "$request" $time_iso8601'),
  'reverse proxy limits every client',
);
// The backend (apps/api, BR-04, BR-05): the same rewrite-run-restore, with its vitest suite inside workerd.
async function mustFailApi(name, mutate, testName) {
  const path = `${root}apps/api/src/index.ts`;
  const original = await readFile(path, 'utf8');
  const changed = mutate(original);
  if (changed === original) throw new Error(`${name}: mutation target was not located`);
  try {
    await writeFile(path, changed);
    const result = spawnSync('pnpm', ['--filter', '@giveaway/api', 'exec', 'vitest', 'run', '-t', testName], {
      encoding: 'utf8',
    });
    // CI colours vitest's summary even through a pipe; drop the escape codes before reading it.
    const output = (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, '');
    if (result.status === 0 || !/Tests\s+\d+ failed/.test(output))
      throw new Error(`${name} did not fail the tests (exit ${result.status}):\n${output.slice(-3000)}`);
    const failed = output.split('\n').find((line) => line.includes('FAIL') && line.includes('>'));
    console.log(`${name} causes backend test failure${failed ? ` (${failed.trim().slice(0, 200)})` : ''}`);
  } finally {
    await writeFile(path, original);
  }
}
await mustFailApi(
  'Echoing any Origin from the backend',
  (text) => text.replace('if (origin !== null && origin !== allowed)', 'if (origin === "never")'),
  'refuses a page on another origin',
);
await mustFailApi(
  'Logging the request URL in the backend',
  (text) =>
    text.replace(
      'const allowed = allowedOrigin(env);',
      'const allowed = allowedOrigin(env);\n  console.log(request.url);',
    ),
  'writes nothing to the console',
);
