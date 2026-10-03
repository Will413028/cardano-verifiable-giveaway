import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const p = await import(process.env.GIVEAWAY_LIBRARY || '../dist/library.mjs');
const bundle = (entrants = ['alice', 'bob', 'carol', 'dana', 'eli']) => ({ version: p.VERSION, algorithm: p.ALGORITHM,
  drawId: 'example-1', entrants, rules: { winners: 2 }, drand: { chainHash: p.QUICKNET, round: p.FIXTURE.round } });
async function proof() {
  const b = bundle(), chain = new p.DemoChain(), c = await chain.commit(b);
  chain.confirm(c);
  return { format: 'giveaway-proof-1', network: 'demo', bundle: b, commitment: c, beacon: structuredClone(p.FIXTURE), winners: await p.selectWinners(b, p.FIXTURE.randomness) };
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
  assert.deepEqual(p.parseEntrants('label,email,phone\r\n"Alice, A",private@example.com,123456789\r\n"Bo""b",x@y.com,987654321'), ['Alice, A', 'Bo"b']);
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
});
test('real quicknet BLS fixture passes; altered round, signature and randomness fail', async () => {
  assert.equal(await p.verifyBeacon(p.FIXTURE, p.FIXTURE.round), true);
  assert.equal(await p.verifyBeacon({ ...p.FIXTURE, round: p.FIXTURE.round + 1 }, p.FIXTURE.round + 1), false);
  assert.equal(await p.verifyBeacon({ ...p.FIXTURE, signature: p.FIXTURE.signature.slice(0, -2) + '00' }, p.FIXTURE.round), false);
  assert.equal(await p.verifyBeacon({ ...p.FIXTURE, randomness: '0'.repeat(64) }, p.FIXTURE.round), false);
  assert.equal(await p.verifyBeacon({ ...p.FIXTURE, signature: 'c0' + '00'.repeat(47) }, p.FIXTURE.round), false);
});
test('complete demo independently verifies and has a distinct verdict', async () => {
  const v = await p.verifyProof(await proof());
  assert.equal(v.status, 'DEMO PASS'); assert.equal(v.checks.length, 8);
  assert.match(v.boundary, /eligibility/);
});
test('non-string network cannot bypass chain checks or upgrade demo verdict', async () => {
  const x = await proof(); x.network = ['demo'];
  assert.equal((await p.verifyProof(x)).status, 'FAIL');
  x.network = 'demo'; x.commitment.txHash = [x.commitment.txHash];
  assert.equal((await p.verifyProof(x)).status, 'FAIL');
});
test('tampered entrant, declared winners and signature are rejected', async () => {
  for (const mutate of [x => { x.bundle.entrants[0] = 'mallory'; }, x => { x.winners = ['mallory']; },
    x => { x.beacon.signature = x.beacon.signature.slice(0, -2) + '00'; }]) {
    const x = await proof(); mutate(x); assert.equal((await p.verifyProof(x)).status, 'FAIL');
  }
});
test('missing, late confirmations and future rounds fail closed', async () => {
  const x = await proof(); x.commitment.confirmedAt = 0;
  assert.equal((await p.verifyProof(x)).status, 'FAIL');
  x.commitment.confirmedAt = p.roundTime(x.bundle.drand.round);
  assert.equal((await p.verifyProof(x)).status, 'FAIL');
  const y = await proof(); assert.equal((await p.verifyProof(y, { now: p.roundTime(y.bundle.drand.round) - 1 })).status, 'FAIL');
});
test('earliest same-address draw wins, same-block ambiguity fails closed', async () => {
  const x = await proof(), target = x.commitment;
  const earlier = { ...target, txHash: 'a'.repeat(64), blockHeight: target.blockHeight - 1 };
  assert.equal(p.checkUniqueness([target, earlier], target), false);
  assert.equal(p.checkUniqueness([target, { ...earlier, owner: 'another-owner' }], target), true);
  assert.equal(p.checkUniqueness([target, { ...earlier, blockHeight: target.blockHeight }], target), false);
});
test('preprod uses authoritative chain evidence rather than artifact timing/hash', async () => {
  const x = await proof(); x.network = 'preprod'; const c = structuredClone(x.commitment);
  x.commitment.bundleHash = '0'.repeat(64); x.commitment.confirmedAt = 0;
  const chain = { readCommitment: async () => c, findCommitments: async () => [c] };
  assert.equal((await p.verifyProof(x, { chain })).status, 'PASS');
  const failed = { readCommitment: async () => { throw new Error('Indexer unavailable'); }, findCommitments: async () => [c] };
  assert.equal((await p.verifyProof(x, { chain: failed })).status, 'FAIL');
  chain.findCommitments = async () => [c, { ...c, txHash: 'a'.repeat(64), blockHeight: c.blockHeight - 1 }];
  assert.equal((await p.verifyProof(x, { chain })).status, 'FAIL');
});
test('Koios reads the historical 15th block and verifies organizer input', async () => {
  const x = await proof(), c = x.commitment, owner = 'addr_test1example';
  const chain = new p.KoiosChain(); const calls = [];
  chain.query = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === 'tx_info') return [{ tx_hash: c.txHash, inputs: [{ payment_addr: { bech32: owner } }], block_height: c.blockHeight, tx_timestamp: c.blockTime }];
    if (endpoint === 'tx_metadata') return [{ tx_hash: c.txHash, metadata: { [p.LABEL]: p.commitmentMetadata(x.bundle, c.bundleHash) } }];
    return [{ block_height: c.blockHeight + 14, block_time: c.confirmedAt }];
  };
  assert.equal((await chain.readCommitment(c.txHash, owner)).confirmedAt, c.confirmedAt);
  assert.ok(calls.includes(`blocks?block_height=eq.${c.blockHeight + 14}&limit=1`));
  await assert.rejects(chain.readCommitment(c.txHash, 'addr_test1different'), /not a transaction input/);
});
test('relay failure falls back; invalid signatures cannot be accepted', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => ++calls === 1 ? new Response('down', { status: 503 }) : Response.json(p.FIXTURE);
    assert.deepEqual(await p.fetchBeacon(p.FIXTURE.round), p.FIXTURE); assert.equal(calls, 2);
    globalThis.fetch = async () => Response.json({ ...p.FIXTURE, randomness: '0'.repeat(64) });
    await assert.rejects(p.fetchBeacon(p.FIXTURE.round), /No verified beacon/);
  } finally { globalThis.fetch = original; }
});
test('history ignores incoming spoofed commitments and does not wait for later confirmations', async () => {
  const x = await proof(), c = x.commitment, owner = 'addr_test1example', incoming = 'a'.repeat(64);
  const chain = new p.KoiosChain();
  chain.query = async endpoint => {
    if (endpoint.startsWith('address_txs')) return [{ tx_hash: c.txHash }, { tx_hash: incoming }];
    if (endpoint === 'tx_metadata') return [c.txHash, incoming].map(tx_hash => ({ tx_hash, metadata: { [p.LABEL]: p.commitmentMetadata(x.bundle, c.bundleHash) } }));
    if (endpoint === 'tx_info') return [
      { tx_hash: c.txHash, inputs: [{ payment_addr: { bech32: owner } }], block_height: c.blockHeight, tx_timestamp: c.blockTime },
      { tx_hash: incoming, inputs: [{ payment_addr: { bech32: 'addr_test1attacker' } }], block_height: c.blockHeight - 1, tx_timestamp: c.blockTime - 1 },
    ];
    throw new Error('Candidate ordering must not fetch confirmation blocks');
  };
  const candidates = await chain.findCommitments(x.bundle.drawId, owner);
  assert.equal(candidates.length, 1); assert.equal(candidates[0].txHash, c.txHash);
  assert.equal(candidates[0].confirmedAt, 0);
});
