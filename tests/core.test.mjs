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
test('earliest same-address draw wins, same-block ambiguity fails closed', async () => {
  const target = await p.demoInclusion(bundle());
  const earlier = { ...target, txHash: 'a'.repeat(64), blockHeight: target.blockHeight - 1 };
  assert.equal(p.checkUniqueness([target, earlier], target), false);
  assert.equal(p.checkUniqueness([target, { ...earlier, owner: 'another-owner' }], target), true);
  assert.equal(p.checkUniqueness([target, { ...earlier, blockHeight: target.blockHeight }], target), false);
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
  for (const name of ['Commitment hash', 'Timing and confirmations', 'Earliest commitment'])
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
test('history ignores incoming spoofed commitments and does not wait for later confirmations', async () => {
  const { x, c } = await preprod(),
    owner = c.owner,
    incoming = 'a'.repeat(64);
  const chain = new p.KoiosChain();
  chain.query = async (endpoint) => {
    if (endpoint.startsWith('address_txs')) return [{ tx_hash: c.txHash }, { tx_hash: incoming }];
    if (endpoint === 'tx_metadata')
      return [c.txHash, incoming].map((tx_hash) => ({
        tx_hash,
        metadata: { [p.LABEL]: p.commitmentMetadata(x.bundle, c.bundleHash) },
      }));
    if (endpoint === 'tx_info')
      return [
        {
          tx_hash: c.txHash,
          inputs: [{ payment_addr: { bech32: owner } }],
          block_height: c.blockHeight,
          tx_timestamp: c.blockTime,
        },
        {
          tx_hash: incoming,
          inputs: [{ payment_addr: { bech32: 'addr_test1attacker' } }],
          block_height: c.blockHeight - 1,
          tx_timestamp: c.blockTime - 1,
        },
      ];
    throw new Error('Candidate ordering must not fetch confirmation blocks');
  };
  const candidates = await chain.findCommitments(x.bundle.drawId, owner);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].txHash, c.txHash);
  assert.equal('confirmedAt' in candidates[0], false);
});
