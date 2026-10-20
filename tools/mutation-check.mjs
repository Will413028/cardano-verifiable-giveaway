import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
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
  [
    'withdrawal',
    'Unsigned transaction withdrawal differs from the organizer reward account balance',
    'unsigned commitment re-read: withdrawal',
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
// Step 8b: the Blockfrost-shaped adapter (PD7). One guard per mutation, each against the test written for it.
await mustFail(
  'CLI falling back to a default indexer',
  `${root}apps/verifier-cli/index.mjs`,
  (text) =>
    text
      .replace('if (!indexer) {', 'if (false) {')
      .replace('const chain = chainFor(indexer);', "const chain = chainFor(indexer ?? 'http://127.0.0.1:3010');"),
  'CLI requires --indexer',
);
await mustFail(
  'Enumerating only the first page of the withdrawal list',
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
  'Taking a non-2xx answer of the withdrawal list as an empty page',
  library,
  (text) => text.replace(/(const listed = await this\.page\([^;]*\));/, '$1.catch(() => []);'),
  'any non-2xx answer for the withdrawal list',
);
// Step 9b (PD10): the history is the organizer reward account's withdrawal list. One guard per mutation.
await mustFail(
  'Not requiring the commitment to withdraw from the organizer reward account',
  library,
  (text) => text.replace('if (!tx.withdrawals.has(identityRewardAccount(owner)))', 'if (false)'),
  'PD10: a commitment without a withdrawal',
);
await mustFail(
  'Reading the withdrawal list past the round',
  library,
  (text) => text.replace('if (row.block_time >= end) break read;', ''),
  'the withdrawal list is read only up to the round',
);
await mustFail(
  'Removing the withdrawal row limit',
  library,
  (text) => text.replace('if (rows.length > HISTORY_ROW_LIMIT) throw historyTooLarge();', ''),
  'history over L withdrawal rows',
);
await mustFail(
  'Trusting the withdrawal list order',
  library,
  (text) => text.replace('if (row.block_height < previous.height || row.block_time < previous.time)', 'if (false)'),
  'a withdrawal list out of ascending order',
);
await mustFail(
  'Allowing an enterprise organizer address',
  library,
  (text) =>
    text.replace(
      /if \(type === 6\)\s*throw new Error\(\s*"Organizer address must be a base address with a stake key[^"]*"\s*\);/,
      'if (type === 6 && bytes.length === 29) return { kind: "stake", key: hex(bytes.slice(1)) };',
    ),
  'enterprise organizer is refused',
);
// Step 10b: the email check runs in linear time. Its differential test cannot see the former pattern (same answers),
// so putting it back must fail the test that records which patterns label normalization runs.
await mustFail(
  'Putting the former backtracking email pattern back',
  library,
  (text) =>
    text.replace(
      'function emailShaped(label) {\n',
      'function emailShaped(label) {\n  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(label);\n',
    ),
  'label normalization runs no backtracking pattern',
  `${root}tests/email.test.mjs`,
);
// Step 10b: emailShaped must give the former pattern's answers; each guard changed alone fails the differential test.
for (const [name, from, to] of [
  ['an "@" in first position', 'if (at < 1 ||', 'if (at < 0 ||'],
  ['a second "@"', 'label.includes("@", at + 1) || ', ''],
  ['whitespace', ' || /\\s/.test(label)) return false;', ') return false;'],
  ['non-ASCII whitespace', '/\\s/.test(label)', '/[ \\t\\n\\r\\f\\v]/.test(label)'],
  ['a "." first in the domain', 'label.indexOf(".", at + 2)', 'label.indexOf(".", at + 1)'],
  ['a "." last in the label', 'dot < label.length - 1', 'dot < label.length'],
])
  await mustFail(
    `emailShaped accepting ${name} differently from the former pattern`,
    library,
    (text) => text.replace(from, to),
    'emailShaped agrees with the former email pattern',
    `${root}tests/email.test.mjs`,
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
async function mustFailApi(name, mutate, testName, path = `${root}apps/api/src/index.ts`) {
  const original = await readFile(path, 'utf8');
  const changed = mutate(original);
  if (changed === original) throw new Error(`${name}: mutation target was not located`);
  try {
    await writeFile(path, changed);
    const result = spawnSync('pnpm', ['--filter', '@giveaway/api', 'exec', 'vitest', 'run', '-t', testName], {
      encoding: 'utf8',
    });
    // CI colours vitest's summary even through a pipe; drop the escape codes before reading it.
    const output = stripVTControlCharacters(result.stdout + result.stderr);
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
// Bundle hosting (plan step 10, B4): one guard per mutation, each against the backend test written for it.
const bundles = `${root}apps/api/src/bundles.ts`;
await mustFailApi(
  'Skipping validateBundle in the upload gate',
  (text) => text.replace('bundle = validateBundle(value);', 'bundle = value as Bundle;'),
  'refuses bytes that fail validateBundle',
  bundles,
);
await mustFailApi(
  'Not writing the takedown tombstone',
  (text) =>
    text.replace(
      "env.DB.prepare('INSERT OR IGNORE INTO tombstones (bundle_hash, removed_at) VALUES (?, ?)').bind(bundleHash, now),",
      '',
    ),
  'an operator takedown removes every record',
  bundles,
);
await mustFailApi(
  'Deleting hosted bytes without counting the records that still name them',
  (text) =>
    text.replace(
      'const unreferenced = results.map((row) => objectKey(row.bundle_hash));',
      'const unreferenced = bundleHashes.map(objectKey);',
    ),
  'removing one record keeps bytes another record still names',
  bundles,
);
// Step 10 review fixes (H1, M1, M2): one guard per mutation, each against the backend test written for it.
await mustFailApi(
  'Accepting bytes that parse to a valid bundle without being its canonical serialization',
  (text) => text.replace('if (canonical !== text)', 'if (canonical === null)'),
  'refuses bytes that parse to a valid bundle but are not its canonical serialization',
  bundles,
);
await mustFailApi(
  'Matching the commitment by bundle hash only (not drawId and drand round)',
  (text) =>
    text.replace('if (!matchesCommitment(bundle, bundleHash, committed))', 'if (bundleHash !== committed.bundleHash)'),
  'refuses a bundle whose drand round is not the round its commitment names',
  bundles,
);
await mustFailApi(
  'Not re-checking the record after writing its bytes',
  (text) => text.replace('  if (live) return;\n', '  return;\n'),
  'a takedown or deletion between the record write and the byte write',
  bundles,
);
await mustFailApi(
  'Inserting a record while its bytes are claimed for deletion',
  (text) => text.replace('       AND NOT EXISTS (SELECT 1 FROM collecting WHERE bundle_hash = ?2)\n', ''),
  'is refused, and hosts them when retried',
  bundles,
);
await mustFailApi(
  'Not running the reconciliation on the Cron trigger',
  (text) => text.replace('    await reconcile(env, now);\n', ''),
  'reclaimed by the Cron reconciliation',
);
// Step 10b (ADR Amendment 5): retention counts from the earlier of the round time and the upload.
await mustFailApi(
  'Counting retention from the round time only',
  (text) => text.replace('return Math.min(roundTime(round), uploadedAt);', 'return roundTime(round);'),
  'a round far after the upload',
  `${root}apps/api/src/retention.ts`,
);
await mustFailApi(
  'Counting retention from each upload instead of the first hosting',
  (text) => text.replace('const firstHosted = first?.first_hosted_at ?? now;', 'const firstHosted = now;'),
  'an expired record uploaded again before its round gets no new period',
  bundles,
);
// Step 10b round-2 review: the first hosting time is written only by an upload that made a record, never replaced,
// and kept until no expiry it gives can be open. One guard per mutation.
await mustFailApi(
  'Recording the first hosting time for an upload that made no record',
  (text) =>
    text.replace(
      'SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM hosted WHERE tx_hash = ?1 AND hosted_at = ?2)',
      'SELECT ?1, ?2, ?3',
    ),
  'a refused upload does not start the clock',
  bundles,
);
await mustFailApi(
  'Replacing the first hosting time on a later hosting',
  (text) =>
    text.replace(
      '       ON CONFLICT (tx_hash) DO NOTHING`,\n    ).bind(txHash, now, firstHostingKeepUntil',
      '       ON CONFLICT (tx_hash) DO UPDATE SET first_hosted_at = excluded.first_hosted_at`,\n    ).bind(txHash, now, firstHostingKeepUntil',
    ),
  'keeps the expiry of its first hosting',
  bundles,
);
await mustFailApi(
  'Keeping the first hosting time only until 12 months after the round',
  (text) =>
    text.replace(
      'return byRound === null ? null : Math.max(byRound, hostingExpiry(round, firstHosted, extensions));',
      'return byRound;',
    ),
  'also across a month-end',
  `${root}apps/api/src/retention.ts`,
);
// Step 11 (signed owner operations, BR-09, BR-17; ADR Amendment 5): one guard per mutation, each against the backend
// test written for it.
const auth = `${root}apps/api/src/auth.ts`;
await mustFailApi(
  'Dropping the one-time nonce check (a used nonce is recorded again instead of refused)',
  (text) =>
    text.replace(
      'ON CONFLICT (nonce) DO NOTHING RETURNING nonce',
      'ON CONFLICT (nonce) DO UPDATE SET expires_at = excluded.expires_at RETURNING nonce',
    ),
  'refuses a reused nonce',
  auth,
);
await mustFailApi(
  "Not checking the nonce's issue time against the message (a message may be post-dated)",
  (text) => text.replace('  if (Number.parseInt(parts[2], 16) !== issuedAt) return false;\n', ''),
  'post-dated past its nonce',
  auth,
);
await mustFailApi(
  "Not checking the nonce's MAC (anyone may mint a nonce)",
  (text) => text.replace('  if (!valid) return false;\n', ''),
  'post-dated past its nonce',
  auth,
);
await mustFailApi(
  'Accepting owner operations without a configured page origin',
  (text) =>
    text.replace(
      'if (expected.domain === null || op.domain !== expected.domain)',
      'if (expected.domain !== null && op.domain !== expected.domain)',
    ),
  'refuses owner operations when no page origin is configured',
  auth,
);
await mustFailApi(
  "Dropping the key-versus-owner check (any key's valid signature authorizes)",
  (text) => text.replace('  if (!byOwner)\n', '  if (false)\n'),
  "refuses any key but the commitment's organizer stake key",
  auth,
);
await mustFailApi(
  'Accepting a signed message past its 5-minute window',
  (text) => text.replace('  if (now >= op.issuedAt + OWNER_OPERATION_VALIDITY)\n', '  if (false)\n'),
  'refuses an expired message',
  auth,
);
await mustFailApi(
  "Letting anyone's signed upload create the hosting (and start the retention clock)",
  (text) => text.replace('  requireOwner(signed, owner);\n', ''),
  'a third party cannot host, so cannot start the clock',
  bundles,
);
await mustFailApi(
  'Dropping the owner extensions when the commitment is hosted again',
  (text) =>
    text.replace(
      'const expiresAt = hostingExpiry(round, firstHosted, first?.extensions ?? 0);',
      'const expiresAt = hostingExpiry(round, firstHosted);',
    ),
  'extensions are counted from the base time and kept across a deletion',
  bundles,
);
await mustFailApi(
  'Not rate limiting the write routes per client address',
  (text) =>
    text.replace(
      'if (WRITES.has(request.method) && (await limited(request, env)))',
      'if (WRITES.has(request.method) && false)',
    ),
  'refuses writes past 20 a minute from one address',
);
await mustFailApi(
  'Keying the rate limit on the full IPv6 address instead of its /64',
  (text) =>
    text.replace(
      "key: clientKey(request.headers.get('CF-Connecting-IP'))",
      "key: request.headers.get('CF-Connecting-IP') ?? 'unknown'",
    ),
  'counts every address of one IPv6 /64 together',
);
// Step 11 review L1–L3: one guard per mutation.
await mustFailApi(
  'Not checking the owner when a live hosting is uploaded again (L1)',
  (text) => text.replace('    requireOwner(signed, existing.owner);\n', ''),
  'a live hosting is not rewritten by another key either',
  bundles,
);
await mustFailApi(
  'Not checking the signed bundle hash against the uploaded bytes (L2)',
  (text) => text.replace('  if (signed.op.bundleHash !== bundleHash)\n', '  if (false)\n'),
  'the signed bundle hash must be the hash of the uploaded bytes',
  bundles,
);
await mustFailApi(
  'Counting an extension whatever count it was computed from (L3)',
  (text) => text.replace('WHERE tx_hash = ?1 AND extensions = ?2 - 1', 'WHERE tx_hash = ?1'),
  'of two extensions computed from the same state',
  `${root}apps/api/src/owner.ts`,
);
// Step 11 review L4: COSE verification guards, in the built library the Node tests load.
await mustFail(
  'Verifying COSE signatures with ZIP 215 (cofactored) instead of strict RFC 8032',
  library,
  (text) =>
    text.replace(
      'ed25519.verify(sig, sigStructure(protectedBytes, payload), publicKey, { zip215: false })',
      'ed25519.verify(sig, sigStructure(protectedBytes, payload), publicKey, { zip215: true })',
    ),
  'small-order key',
  `${root}tests/cose.test.mjs`,
);
await mustFail(
  'Accepting a COSE payload flagged as hashed',
  library,
  (text) => text.replace('if (unprotected.get("hashed") === true) return null;', ''),
  'flagged as hashed',
  `${root}tests/cose.test.mjs`,
);
// Step 11 review round 3: the use record refuses anything at or below the sweep watermark (a replay verified inside
// its window but recorded after the sweep), the key length, and the limiter key normalization. One guard each.
for (const testName of [
  'a replayed extension verified inside its window but recorded after the sweep',
  'a replayed upload whose body stalls across the sweep',
])
  await mustFailApi(
    `Recording a nonce use below the sweep watermark (${testName.split(' ').slice(0, 3).join(' ')})`,
    (text) =>
      text.replace('SELECT ?1, ?2 WHERE ?2 > (SELECT swept_through FROM nonce_sweep WHERE id = 1)', 'SELECT ?1, ?2'),
    testName,
    auth,
  );
await mustFailApi(
  'Accepting a NONCE_KEY shorter than 32 characters',
  (text) => text.replace('secret.length < 32', 'secret.length < 1'),
  'refuses a NONCE_KEY shorter than 32 characters',
  auth,
);
for (const [name, from, to] of [
  ['Not lowercasing the client address', "(address ?? '').trim().toLowerCase()", "(address ?? '').trim()"],
  [
    'Not keying an IPv4-mapped IPv6 client by its IPv4 address',
    "  if (text.includes('.')) return text.slice(text.lastIndexOf(':') + 1);\n",
    '',
  ],
  ['Keying a malformed client address as itself', '/^(?:[0-9.]{7,15}|[0-9a-f:.]{2,45})$/.test(text)', 'true'],
])
  await mustFailApi(name, (text) => text.replace(from, to), 'normalizes the client address');
await mustFailApi(
  'Letting an earlier sweep lower the nonce watermark',
  (text) =>
    text.replace(
      "'UPDATE nonce_sweep SET swept_through = max(swept_through, ?) WHERE id = 1'",
      "'UPDATE nonce_sweep SET swept_through = ? WHERE id = 1'",
    ),
  'an earlier sweep after a later one does not lower the watermark',
  auth,
);
