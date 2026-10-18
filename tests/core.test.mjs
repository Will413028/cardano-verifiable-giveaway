import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const p = await import('@giveaway/verifier-cli/library');
const bundle = (entrants = ['alice', 'bob', 'carol', 'dana', 'eli']) => ({
  version: p.VERSION,
  algorithm: p.ALGORITHM,
  drawId: 'example-1',
  entrants,
  rules: { winners: 2 },
  drand: { chainHash: p.QUICKNET, round: p.FIXTURE.round },
});
async function proof() {
  const b = bundle(),
    ref = await new p.DemoChain().commit(b);
  return {
    format: 'giveaway-proof-2',
    network: 'demo',
    bundle: b,
    txHash: ref.txHash,
    owner: ref.owner,
    beacon: structuredClone(p.FIXTURE),
    winners: await p.selectWinners(b, p.FIXTURE.randomness),
  };
}
// A preprod proof and the confirmed commitment a mock indexer reports for it.
async function preprod() {
  const x = await proof();
  const c = { ...(await new p.DemoChain().readCommitment(x.bundle)), owner: 'addr_test1example' };
  return { x: { ...x, network: 'preprod', owner: c.owner }, c };
}
test('independent Python canonical/hash/ranking vectors', async () => {
  const vectors = JSON.parse(await readFile(new URL('./vectors.json', import.meta.url)));
  assert.equal(vectors.length, 10);
  for (const v of vectors) {
    assert.equal(p.canonicalize(v.bundle), v.canonical);
    assert.equal(await p.computeCommitment(v.bundle), v.hash);
    assert.deepEqual(await p.selectWinners(v.bundle, v.randomness), v.winners);
  }
});
test('public label import discards contacts and handles quoted CSV', () => {
  assert.deepEqual(
    p.parseEntrants('label,email,phone\r\n"Alice, A",private@example.com,123456789\r\n"Bo""b",x@y.com,987654321'),
    ['Alice, A', 'Bo"b'],
  );
  assert.deepEqual(p.parseEntrants('e\u0301\nalice'), ['é', 'alice']);
  assert.throws(() => p.parseEntrants('é\ne\u0301'), /Duplicate/);
  assert.throws(() => p.parseEntrants('alice@example.com'), /public participant/);
  assert.throws(() => p.parseEntrants('alice,bob'), /label header/);
  assert.throws(() => p.parseEntrants('"unclosed'), /Unclosed/);
  assert.throws(() => p.parseEntrants('"alice"bob'), /Malformed/);
});
test('bundle rejects duplicates, noncanonical labels, extra fields and invalid counts', () => {
  assert.throws(() => p.validateBundle(bundle(['alice', 'alice'])), /Duplicate/);
  assert.throws(() => p.validateBundle(bundle([' alice', 'bob'])), /NFC/);
  assert.throws(() => p.validateBundle({ ...bundle(), contact: 'private' }), /exactly/);
  assert.throws(() => p.validateBundle({ ...bundle(), rules: { winners: 6 } }), /count/);
  assert.throws(() => p.canonicalize({ invalid: 1.5 }), /Unsupported/);
  assert.throws(() => p.validateBundle(bundle(['x'.repeat(p.MAX_LABEL_UNITS + 1)])), /Invalid participant/);
});
test('worst-case bundle and artifact fit the shared byte limits', () => {
  // Every label at the length limit in 3-byte UTF-8 characters, all distinct.
  const entrants = Array.from({ length: p.MAX_ENTRANTS }, (_, i) =>
    String.fromCharCode(0x4e00 + i).repeat(p.MAX_LABEL_UNITS),
  );
  const b = {
    ...bundle(entrants),
    drawId: 'x'.repeat(64),
    rules: { winners: p.MAX_ENTRANTS },
    drand: { chainHash: p.QUICKNET, round: Number.MAX_SAFE_INTEGER },
  };
  const canonical = Buffer.byteLength(p.canonicalize(p.validateBundle(b)));
  assert.ok(canonical <= p.BUNDLE_BYTE_LIMIT, `${canonical} > ${p.BUNDLE_BYTE_LIMIT}`);
  assert.ok(canonical > p.BUNDLE_BYTE_LIMIT - 1024, 'limit should be tight to the derived worst case');
  const artifact = {
    format: 'giveaway-proof-2',
    network: 'preprod',
    bundle: b,
    txHash: 'f'.repeat(64),
    owner: `addr_test1${'q'.repeat(100)}`,
    beacon: p.FIXTURE,
    winners: entrants,
  };
  const file = Buffer.byteLength(JSON.stringify(artifact, null, 2));
  assert.ok(file <= p.ARTIFACT_BYTE_LIMIT, `${file} > ${p.ARTIFACT_BYTE_LIMIT}`);
  assert.ok(file > p.ARTIFACT_BYTE_LIMIT * 0.99, 'limit should be tight to the derived worst case');
});
test('real quicknet BLS fixture passes; altered round, signature and randomness fail', async () => {
  assert.equal(await p.verifyBeacon(p.FIXTURE, p.FIXTURE.round), true);
  assert.equal(await p.verifyBeacon({ ...p.FIXTURE, round: p.FIXTURE.round + 1 }, p.FIXTURE.round + 1), false);
  assert.equal(
    await p.verifyBeacon({ ...p.FIXTURE, signature: `${p.FIXTURE.signature.slice(0, -2)}00` }, p.FIXTURE.round),
    false,
  );
  assert.equal(await p.verifyBeacon({ ...p.FIXTURE, randomness: '0'.repeat(64) }, p.FIXTURE.round), false);
  assert.equal(await p.verifyBeacon({ ...p.FIXTURE, signature: `c0${'00'.repeat(47)}` }, p.FIXTURE.round), false);
});
test('F6: fixture signature plus a G1 torsion point is rejected', async () => {
  // FIXTURE.signature + T where T has order dividing the G1 cofactor. It satisfies the pairing equation
  // (measured 2026-10-18), so only the prime-order subgroup check stands between it and a second randomness.
  const signature = 'b2fcf4f7d2b5bbabc7bc8bab08d4fadbb341292f830beca085bc05a28e8403c46d20c1665628d579c30f6c3a2ce5495f';
  const forged = { round: p.FIXTURE.round, signature, randomness: await p.sha256(p.unhex(signature)) };
  assert.notEqual(forged.randomness, p.FIXTURE.randomness);
  assert.equal(await p.verifyBeacon(forged, p.FIXTURE.round), false);
});
test('complete demo independently verifies and has a distinct verdict', async () => {
  const v = await p.verifyProof(await proof());
  assert.equal(v.status, 'DEMO PASS');
  assert.equal(v.checks.length, 7);
  assert.ok(v.checks.every((c) => c.result === 'pass'));
  assert.match(v.boundary, /eligibility/);
});
test('non-string network cannot bypass chain checks or upgrade demo verdict', async () => {
  const x = await proof();
  x.network = ['demo'];
  assert.equal((await p.verifyProof(x)).status, 'FAIL');
  x.network = 'demo';
  x.txHash = [x.txHash];
  assert.equal((await p.verifyProof(x)).status, 'FAIL');
});
test('demo reference is bound to the bundle hash', async () => {
  const x = await proof();
  x.txHash = 'a'.repeat(64);
  const v = await p.verifyProof(x);
  assert.equal(v.status, 'FAIL');
  assert.equal(v.checks.find((c) => c.name === 'Commitment hash').result, 'fail');
});
test('tampered entrant, declared winners and signature are rejected', async () => {
  for (const mutate of [
    (x) => {
      x.bundle.entrants[0] = 'mallory';
    },
    (x) => {
      x.winners = ['mallory'];
    },
    (x) => {
      x.beacon.signature = `${x.beacon.signature.slice(0, -2)}00`;
    },
  ]) {
    const x = await proof();
    mutate(x);
    assert.equal((await p.verifyProof(x)).status, 'FAIL');
  }
});
test('late or out-of-order confirmations reported by the chain fail closed', async () => {
  const { x, c } = await preprod();
  for (const confirmedAt of [p.roundTime(x.bundle.drand.round), c.blockTime - 1]) {
    const chain = { readCommitment: async () => ({ ...c, confirmedAt }), findCommitments: async () => [c] };
    const v = await p.verifyProof(x, { chain });
    assert.equal(v.status, 'FAIL');
    assert.equal(v.checks.find((k) => k.name === 'Timing and confirmations').result, 'fail');
  }
});
test('F4: a verifier clock behind the round does not fail a valid beacon', async () => {
  const original = Date.now;
  try {
    Date.now = () => (p.roundTime(p.FIXTURE.round) - 3600) * 1000;
    assert.equal((await p.verifyProof(await proof())).status, 'DEMO PASS');
  } finally {
    Date.now = original;
  }
});
test('uniqueness: overlapping commitments both fail, same block fails closed, late ones block nothing', async () => {
  const target = await p.demoInclusion(bundle());
  const R = p.roundTime(target.round);
  const other = { ...target, txHash: 'a'.repeat(64), drawId: 'other', blockHeight: target.blockHeight + 1 };
  const check = (list, x) => p.checkUniqueness(list, x);
  assert.deepEqual(check([target], target), { passed: true, conflicts: [] });
  // Both sides of an overlap fail and name each other.
  const overlapping = { ...other, blockTime: R - 600 };
  assert.deepEqual(check([target, overlapping], target).conflicts, [overlapping]);
  assert.deepEqual(check([target, overlapping], overlapping).conflicts, [target]);
  // Same block: same inclusion time, so the intervals always overlap, whichever is listed first.
  const sameBlock = { ...other, blockHeight: target.blockHeight, blockTime: target.blockTime };
  assert.equal(check([sameBlock, target], target).passed, false);
  assert.equal(check([target, sameBlock], sameBlock).passed, false);
  // Included at or after its own round: invalid itself, so it blocks nothing even if its interval would overlap.
  // Its round time R - 600 falls inside the target's interval [R - 900, R) and its inclusion R - 300 is after it.
  const lateOwn = { ...other, round: target.round - 200, blockTime: R - 300 };
  assert.equal(target.blockTime, R - 900);
  assert.equal(check([target, lateOwn], target).passed, true);
  // Inclusion exactly at the target's round time does not overlap the half-open interval.
  assert.equal(check([target, { ...other, round: target.round + 10, blockTime: R }], target).passed, true);
  // A history that does not contain the target is incomplete.
  assert.equal(check([overlapping], target).passed, false);
});
test('preprod uses authoritative chain evidence for the referenced transaction', async () => {
  const { x, c } = await preprod();
  const chain = { readCommitment: async () => c, findCommitments: async () => [c] };
  assert.equal((await p.verifyProof(x, { chain })).status, 'PASS');
  chain.readCommitment = async () => ({ ...c, bundleHash: '0'.repeat(64) });
  assert.equal((await p.verifyProof(x, { chain })).status, 'FAIL');
  chain.readCommitment = async () => c;
  chain.findCommitments = async () => [c, { ...c, txHash: 'a'.repeat(64), blockHeight: c.blockHeight - 1 }];
  assert.equal((await p.verifyProof(x, { chain })).status, 'FAIL');
});
test('F3: checks that depend on unavailable chain evidence are not evaluated', async () => {
  const { x } = await preprod();
  const failed = {
    readCommitment: async () => {
      throw new Error('Indexer unavailable');
    },
    findCommitments: async () => [],
  };
  const v = await p.verifyProof(x, { chain: failed });
  assert.equal(v.status, 'FAIL');
  const result = Object.fromEntries(v.checks.map((c) => [c.name, c.result]));
  assert.equal(result['Cardano evidence'], 'fail');
  for (const name of ['Commitment hash', 'Timing and confirmations', 'Unique commitment'])
    assert.equal(result[name], 'unevaluated', name);
  assert.equal(result['drand BLS signature'], 'pass');
  const unsigned = await p.verifyProof({ ...(await proof()), beacon: { ...p.FIXTURE, randomness: '0'.repeat(64) } });
  assert.equal(unsigned.checks.find((c) => c.name === 'Winner recomputation').result, 'unevaluated');
});
test('F5: artifacts carry only the commitment reference', async () => {
  const x = await proof();
  const c = await new p.DemoChain().readCommitment(x.bundle);
  for (const extra of [{ commitment: c }, { confirmedAt: c.confirmedAt }, { bundleHash: c.bundleHash }])
    assert.equal((await p.verifyProof({ ...x, ...extra })).status, 'FAIL');
  assert.equal((await p.verifyProof({ ...x, format: 'giveaway-proof-1' })).status, 'FAIL');
  const pending = { format: 'giveaway-pending-2', network: 'preprod', bundle: x.bundle, txHash: x.txHash, owner: 'o' };
  assert.equal(p.validatePending(pending).txHash, x.txHash);
  assert.throws(() => p.validatePending({ ...pending, commitment: c }), /exactly/);
  assert.throws(() => p.validatePending({ ...pending, format: 'giveaway-pending-1' }), /Unsupported/);
});
// A Koios mock for one committed transaction; `label` is where the metadata is stored.
function koios(x, c, owner, calls = [], label = p.LABEL) {
  const chain = new p.KoiosChain();
  chain.query = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === 'tx_info')
      return [
        {
          tx_hash: c.txHash,
          inputs: [{ payment_addr: { bech32: owner } }],
          block_height: c.blockHeight,
          tx_timestamp: c.blockTime,
        },
      ];
    if (endpoint === 'tx_metadata')
      return [{ tx_hash: c.txHash, metadata: { [label]: p.commitmentMetadata(x.bundle, c.bundleHash) } }];
    return [{ block_height: c.blockHeight + 14, block_time: c.confirmedAt }];
  };
  return chain;
}
test('Koios reads the historical 15th block and verifies organizer input', async () => {
  const { x, c } = await preprod(),
    calls = [];
  const chain = koios(x, c, c.owner, calls);
  assert.equal((await chain.readCommitment(c.txHash, c.owner)).confirmedAt, c.confirmedAt);
  assert.ok(calls.includes(`blocks?block_height=eq.${c.blockHeight + 14}&limit=1`));
  await assert.rejects(chain.readCommitment(c.txHash, 'addr_test1different'), /not a transaction input/);
});
test('F7: commitments under the CIP-20 message label 674 are not supported', async () => {
  const { x, c } = await preprod();
  assert.notEqual(p.LABEL, 674);
  await assert.rejects(koios(x, c, c.owner, [], 674).readCommitment(c.txHash, c.owner), /Unsupported commitment/);
});
test('relay failure falls back; invalid signatures cannot be accepted', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => (++calls === 1 ? new Response('down', { status: 503 }) : Response.json(p.FIXTURE));
    assert.deepEqual(await p.fetchBeacon(p.FIXTURE.round), p.FIXTURE);
    assert.equal(calls, 2);
    globalThis.fetch = async () => Response.json({ ...p.FIXTURE, randomness: '0'.repeat(64) });
    await assert.rejects(p.fetchBeacon(p.FIXTURE.round), /No verified beacon/);
  } finally {
    globalThis.fetch = original;
  }
});
// Cardano addresses for the organizer, a second wallet and a third party that reuses the organizer's stake part
// (CIP-19 lets anyone build such an address). The stake identity comes from a real preprod base address whose
// stake address Koios reports as below (2026-10-19).
const keyHash = (byte) => new Uint8Array(28).fill(byte);
const address = (payment, stake) =>
  p.encodeBech32('addr_test', Uint8Array.from(stake ? [0x00, ...payment, ...stake] : [0x60, ...payment]));
const ORGANIZER_STAKE = keyHash(0x22);
const ORGANIZER = address(keyHash(0x11), ORGANIZER_STAKE);
const THIRD_PARTY = address(keyHash(0x33), ORGANIZER_STAKE);
const OTHER_WALLET = address(keyHash(0x44), keyHash(0x55));
test('identity is the stake credential when present, otherwise the payment credential', () => {
  const real =
    'addr_test1qq99squlfgmcgxaphmqydchcwfrxf5wuwgckd7lcfashmtzc5uj7mzanqm7z93xcrhc7se409hcy839khvsy43mn0y9s8u87rz';
  assert.deepEqual(p.identityOf(real), {
    kind: 'stake',
    key: 'stake_test1upv2wf0d3wesdlpzcnvpmu0gv6hjmuzrcjmtkgz2caehjzch5uhyx',
  });
  assert.deepEqual(p.identityOf('addr_test1vp2tm2edv657xp2as78nkxqausp0s3cwx5vv804r6zlxy9skmt69m'), {
    kind: 'payment',
    key: '54bdab2d66a9e3055d878f3b181de402f8470e3518c3bea3d0be6216',
  });
  assert.equal(p.identityOf(THIRD_PARTY).key, p.identityOf(ORGANIZER).key);
  assert.throws(() => p.identityOf(`${real.slice(0, -1)}q`), /checksum/);
  assert.throws(
    () => p.identityOf(p.encodeBech32('addr_test', Uint8Array.from([0x10, ...keyHash(1), ...keyHash(2)]))),
    /key-hash/,
  );
  assert.throws(
    () => p.identityOf(p.encodeBech32('addr', Uint8Array.from([0x01, ...keyHash(1), ...keyHash(2)]))),
    /preprod/,
  );
});
// A Koios mock over a fixed set of transactions. Each listed transaction is enumerated for `stake`, and its
// inputs, metadata, inclusion and 15th-confirmation time are served from the same record.
function chainOf(txs, stake = p.identityOf(ORGANIZER).key, calls = []) {
  const chain = new p.KoiosChain();
  const byHash = (body) => txs.filter((t) => body._tx_hashes.includes(t.txHash));
  chain.query = async (endpoint, body) => {
    calls.push(endpoint);
    if (endpoint.startsWith('account_txs?')) {
      const q = new URLSearchParams(endpoint.slice('account_txs?'.length));
      assert.equal(q.get('_stake_address'), stake);
      assert.equal(q.get('order'), 'block_height.asc,tx_hash.asc');
      const offset = Number(q.get('offset')),
        limit = Number(q.get('limit'));
      return txs.slice(offset, offset + limit).map((t) => ({ tx_hash: t.txHash, block_height: t.blockHeight }));
    }
    if (endpoint === 'tx_metadata') {
      assert.ok(body._tx_hashes.length <= 50, 'Koios rejects bodies over 5 KiB');
      return byHash(body).map((t) => ({ tx_hash: t.txHash, metadata: { [p.LABEL]: t.metadata } }));
    }
    if (endpoint === 'tx_info')
      return byHash(body).map((t) => ({
        tx_hash: t.txHash,
        // Koios returns no inputs unless they are requested.
        inputs: body._inputs ? t.inputs.map((bech32) => ({ payment_addr: { bech32 } })) : [],
        block_height: t.blockHeight,
        tx_timestamp: t.blockTime,
      }));
    const height = Number(endpoint.match(/block_height=eq\.(\d+)/)?.[1]);
    const t = txs.find((x) => x.blockHeight + p.CONFIRMATIONS - 1 === height);
    return t ? [{ block_height: height, block_time: t.blockTime + 300 }] : [];
  };
  return chain;
}
// One committed draw: its bundle, the proof the organizer publishes and the transaction the chain holds.
const R = p.FIXTURE.round;
const T = p.roundTime(R);
// A real quicknet beacon for a second round, fetched from api.drand.sh on 2026-10-19 and verified below.
const BEACON_2 = {
  round: 1000400,
  randomness: '2ada6b787bba749d616a35229c3e06f3e66a78e645a73d004e2e806077d1833f',
  signature: 'b3cc72874340092d770c77fef11d63a7c28567ac2a7bb76aa8ddd23810d5880e2a5036bd560de615affb9c59330c897c',
};
async function draw({ drawId, round = R, blockTime, blockHeight, from = ORGANIZER, beacon = p.FIXTURE }) {
  const b = { ...bundle(), drawId, drand: { chainHash: p.QUICKNET, round } };
  const bundleHash = await p.computeCommitment(b);
  const txHash = await p.sha256(`${drawId}:${round}:${blockHeight}:${from}`);
  const tx = { txHash, inputs: [from], metadata: p.commitmentMetadata(b, bundleHash), blockHeight, blockTime };
  const proof = {
    format: 'giveaway-proof-2',
    network: 'preprod',
    bundle: b,
    txHash,
    owner: from,
    beacon,
    winners: await p.selectWinners(b, beacon.randomness),
  };
  return { tx, proof };
}
const verify = (d, txs) => p.verifyProof(d.proof, { chain: chainOf(txs.map((x) => x.tx)) });
const uniqueness = (v) => v.checks.find((c) => c.name === 'Unique commitment');
const target = () => draw({ drawId: 'example-1', blockTime: T - 900, blockHeight: 1000 });
test('F1 overlap: same wallet, same round, different drawId fails both', async () => {
  const a = await target();
  const b = await draw({ drawId: 'example-2', blockTime: T - 600, blockHeight: 1100 });
  for (const [mine, theirs] of [
    [a, b],
    [b, a],
  ]) {
    const v = await verify(mine, [a, b]);
    assert.equal(v.status, 'FAIL');
    assert.equal(uniqueness(v).result, 'fail');
    assert.deepEqual(
      v.conflicts.map((c) => [c.txHash, c.drawId, c.round]),
      [[theirs.tx.txHash, theirs.proof.bundle.drawId, R]],
    );
    assert.match(uniqueness(v).detail, new RegExp(theirs.tx.txHash));
    assert.ok(v.checks.filter((c) => c !== uniqueness(v)).every((c) => c.result === 'pass'));
  }
});
test('F1 overlap: same wallet, adjacent rounds R and R+1 fails', async () => {
  const a = await target();
  const b = await draw({ drawId: 'example-2', round: R + 1, blockTime: T - 600, blockHeight: 1100 });
  const v = await verify(a, [a, b]);
  assert.equal(v.status, 'FAIL');
  assert.deepEqual(
    v.conflicts.map((c) => c.txHash),
    [b.tx.txHash],
  );
  assert.equal(p.checkUniqueness([a, b].map(inclusion), inclusion(b)).passed, false);
});
test('F1 overlap: a commitment sent after the round does not affect the completed draw', async () => {
  const a = await target();
  // Same drawId and round, included after the round; and a new draw for a later round, included after R.
  const resend = await draw({ drawId: 'example-1', blockTime: T + 60, blockHeight: 1300 });
  const later = await draw({ drawId: 'example-2', round: R + 100, blockTime: T + 60, blockHeight: 1301 });
  const v = await verify(a, [a, resend, later]);
  assert.equal(v.status, 'PASS');
  assert.deepEqual(v.conflicts, []);
});
test('F1 overlap: consecutive draws with non-overlapping intervals both pass', async () => {
  assert.equal(await p.verifyBeacon(BEACON_2, BEACON_2.round), true);
  const a = await target();
  const b = await draw({
    drawId: 'example-2',
    round: BEACON_2.round,
    blockTime: T + 30,
    blockHeight: 1200,
    beacon: BEACON_2,
  });
  for (const d of [a, b]) {
    const v = await verify(d, [a, b]);
    assert.equal(v.status, 'PASS', JSON.stringify(v.checks));
    assert.deepEqual(v.conflicts, []);
  }
});
test('F1 overlap: a third party using the organizer stake part without its key does not fail the draw', async () => {
  const a = await target();
  // Listed under the organizer's stake address, interval overlapping, but spent from the third party's own key.
  const forged = await draw({ drawId: 'example-2', blockTime: T - 600, blockHeight: 1100, from: THIRD_PARTY });
  const v = await verify(a, [a, forged]);
  assert.equal(v.status, 'PASS');
  assert.deepEqual(v.conflicts, []);
  // The third party's own proof does not pass as the organizer's either: its owner is the third-party address.
  assert.equal(forged.proof.owner, THIRD_PARTY);
});
function inclusion(d) {
  return {
    txHash: d.tx.txHash,
    owner: d.proof.owner,
    bundleHash: d.tx.metadata.bundleHash,
    drawId: d.tx.metadata.drawId,
    round: d.tx.metadata.round,
    blockHeight: d.tx.blockHeight,
    blockTime: d.tx.blockTime,
  };
}
test('history enumerates by identity, ignores incoming commitments and does not wait for confirmations', async () => {
  const a = await target();
  const incoming = await draw({ drawId: 'example-1', blockTime: T - 1000, blockHeight: 999, from: OTHER_WALLET });
  const calls = [];
  const chain = chainOf([incoming.tx, a.tx], p.identityOf(ORGANIZER).key, calls);
  const candidates = await chain.findCommitments(ORGANIZER);
  assert.deepEqual(candidates, [inclusion(a)]);
  assert.ok(
    calls.every((c) => !c.startsWith('blocks')),
    'Candidate ordering must not fetch confirmation blocks',
  );
  // An enterprise address has no stake part and is enumerated by its payment credential.
  const enterprise = address(keyHash(0x11));
  const credential = new p.KoiosChain();
  let body;
  credential.query = async (endpoint, b) => {
    if (endpoint.startsWith('credential_txs?')) body = b;
    return [];
  };
  assert.deepEqual(await credential.findCommitments(enterprise), []);
  assert.deepEqual(body, { _payment_credentials: ['11'.repeat(28)] });
});
test('history over the development page limit fails instead of truncating', async () => {
  const calls = [];
  const chain = new p.KoiosChain();
  chain.query = async (endpoint) => {
    calls.push(endpoint);
    return Array.from({ length: 1000 }, (_, i) => ({ tx_hash: i.toString(16).padStart(64, '0') }));
  };
  await assert.rejects(chain.findCommitments(ORGANIZER), /exceeds development query limit/);
  assert.equal(calls.length, 5);
});
// Preprod transaction 3883c2a9 (label 1 metadata), raw CBOR from Koios tx_cbor (spike S1 fixture, 2026-10-18).
const PREPROD_TX =
  '84a500d9010281825820c93e247d43ebaf4542ffa8981206cd02e52d51e48af0226e4da81bdb9cc845e200018182581d6038be2f76b5bc38cb9efca623097b278e4a56b7dcf61ed7555c2c60221ae2600d79021a0002a1fd031a08247cf2075820be3c719e6d876dac1e0f60892d612d7e5b6a9a29671cd05a71ed6b0f4f6a6e9ea100d9010281825820f6641bdf366ff90a3592220e88aef7859ebd5ad68a614418dc66b144b23ff83b5840303ae33a9cc91239f7aecf2017a25ef6319e4a5bdebd5da582f79f9a98cf3bff7bb0abcc792204312cca1901d3adca1a69ba7fcc90a6a21da35ba79e90ba4100f5d90103a100a101a26974696d657374616d706a313739323238383937306d6162736f6c7574655f736c6f7469313336363035373730';
test('trust-path reader hashes the raw body and auxiliary data bytes of a preprod transaction', () => {
  assert.equal(p.transactionHash(PREPROD_TX), '3883c2a93818bc9502844a8f512ddd3a89a25ed2487d80235ad613d43cb93d12');
  const aux = p.auxiliaryDataHash(PREPROD_TX);
  assert.ok(aux.computed !== null && aux.computed === aux.declared);
  // One byte of the first input's transaction id: the hash must move.
  const at = PREPROD_TX.indexOf('5820') + 4 + 62;
  const flipped = `${PREPROD_TX.slice(0, at)}${(parseInt(PREPROD_TX.slice(at, at + 2), 16) ^ 1).toString(16).padStart(2, '0')}${PREPROD_TX.slice(at + 2)}`;
  assert.notEqual(p.transactionHash(flipped), p.transactionHash(PREPROD_TX));
  assert.throws(() => p.transactionHash(`${PREPROD_TX}00`), /trailing/);
});
// An unsigned commitment as Evolution SDK 0.6.0 builds it in apps/web/cardano.ts (base address, 25 ADA input #3,
// epoch 316 parameters); generated by the step 6 comparison harness.
const UNSIGNED =
  '84a400d90102818258203c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c0301828258390011111111111111111111111111111111111111111111111111111111222222222222222222222222222222222222222222222222222222221a001e84808258390011111111111111111111111111111111111111111111111111111111222222222222222222222222222222222222222222222222222222221a015c332b021a0002c0950758206ef13702480e2603dcbecdf94772013c00908282a1483c55afee7b9666f8cd70a0f5d90103a100a11a0135289aa56870726f746f636f6c6d646576656c6f706d656e742d3266647261774964782436663163396135322d386433652d346237612d396332312d3065356434663361326231306a62756e646c654861736878403465316464623039646237303165383835636332363138623235363037626231366637373165316633643964613534646235313562333232393764643861333169636861696e4861736878403532646239626137306530636330663665616637383033646430373434376131663534373737333566643366363631373932626139343630306338346539373165726f756e641a000f43d0';
const ORGANIZER_HEX = `00${'11'.repeat(28)}${'22'.repeat(28)}`;
const plan = () => ({
  input: { txHash: '3c'.repeat(32), index: 3, lovelace: 25000000n },
  address: ORGANIZER_HEX,
  metadata: {
    protocol: p.VERSION,
    drawId: '6f1c9a52-8d3e-4b7a-9c21-0e5d4f3a2b10',
    bundleHash: '4e1ddb09db701e885cc2618b25607bb16f771e1f3d9da54db515b32297dd8a31',
    chainHash: p.QUICKNET,
    round: 1000400,
  },
});
const swap = (from, to, nth = 0) => {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = UNSIGNED.indexOf(from, at + 1);
  assert.ok(at >= 0, `fixture lacks ${from}`);
  return UNSIGNED.slice(0, at) + to + UNSIGNED.slice(at + from.length);
};
test('unsigned commitment re-read accepts the planned transaction', () => {
  const checked = p.checkCommitmentTransaction(UNSIGNED, plan());
  assert.equal(checked.fee, 180373n);
  assert.equal(checked.txHash, p.transactionHash(UNSIGNED));
});
test('unsigned commitment re-read: input', () => {
  assert.throws(
    () => p.checkCommitmentTransaction(UNSIGNED, { ...plan(), input: { ...plan().input, index: 2 } }),
    /unexpected input/,
  );
  const other = { ...plan(), input: { ...plan().input, txHash: '3d'.repeat(32) } };
  assert.throws(() => p.checkCommitmentTransaction(UNSIGNED, other), /unexpected input/);
});
test('unsigned commitment re-read: transfer output', () => {
  assert.throws(() => p.checkCommitmentTransaction(swap('1a001e8480', '1a001e8481'), plan()), /transfer output/);
  assert.throws(
    () => p.checkCommitmentTransaction(UNSIGNED, { ...plan(), address: `00${'33'.repeat(56)}` }),
    /transfer output/,
  );
});
test('unsigned commitment re-read: change address', () => {
  // The second occurrence of the organizer address is the change output.
  const elsewhere = swap(ORGANIZER_HEX, `00${'11'.repeat(28)}${'44'.repeat(28)}`, 1);
  assert.throws(() => p.checkCommitmentTransaction(elsewhere, plan()), /change to another address/);
});
test('unsigned commitment re-read: balance, fields and witnesses', () => {
  assert.throws(() => p.checkCommitmentTransaction(swap('1a015c332b', '1a015c332a'), plan()), /does not balance/);
  // Body map grows by one field (validity start, key 8).
  assert.throws(() => p.checkCommitmentTransaction(swap('84a4', '84a50800'), plan()), /unexpected body field 8/);
  assert.throws(
    () => p.checkCommitmentTransaction(swap('a0f5d90103', 'a10080f5d90103'), plan()),
    /already carries witnesses/,
  );
});
test('unsigned commitment re-read: metadata', () => {
  const draw = { ...plan(), metadata: { ...plan().metadata, drawId: 'another-draw' } };
  assert.throws(() => p.checkCommitmentTransaction(UNSIGNED, draw), /metadata differs/);
  const round = { ...plan(), metadata: { ...plan().metadata, round: 1000401 } };
  assert.throws(() => p.checkCommitmentTransaction(UNSIGNED, round), /metadata differs/);
  // Changing the on-chain round without updating body field 7 is an auxiliary data hash mismatch.
  assert.throws(() => p.checkCommitmentTransaction(swap('1a000f43d0', '1a000f43d1'), plan()), /auxiliary data hash/);
});
