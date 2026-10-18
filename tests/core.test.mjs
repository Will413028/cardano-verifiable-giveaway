import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildTransaction, replaceAuxiliary, testKey, unhex } from './cardano.mjs';
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
// Cardano wallets from deterministic test keys (tests/cardano.mjs): the organizer, the organizer's second payment
// address under the same stake key, another wallet, and a third party that reuses the organizer's stake part in
// its own address (CIP-19 lets anyone build one) but holds only its own payment key.
const ORGANIZER_PAYMENT = testKey(1);
const ORGANIZER_STAKE = testKey(2);
const THIRD_PARTY_PAYMENT = testKey(3);
const ORGANIZER_PAYMENT_2 = testKey(6);
const addressHex = (payment, stake) => (stake ? `00${payment}${stake}` : `60${payment}`);
const bech32 = (h) => p.encodeBech32('addr_test', unhex(h));
const wallet = (payment, stakeHash, keys) => ({
  address: bech32(addressHex(payment.hash, stakeHash)),
  hex: addressHex(payment.hash, stakeHash),
  keys,
});
const ORGANIZER = wallet(ORGANIZER_PAYMENT, ORGANIZER_STAKE.hash, [ORGANIZER_PAYMENT, ORGANIZER_STAKE]);
const ORGANIZER_2 = wallet(ORGANIZER_PAYMENT_2, ORGANIZER_STAKE.hash, [ORGANIZER_PAYMENT_2, ORGANIZER_STAKE]);
const OTHER_WALLET = wallet(testKey(4), testKey(5).hash, [testKey(4), testKey(5)]);
const THIRD_PARTY = wallet(THIRD_PARTY_PAYMENT, ORGANIZER_STAKE.hash, [THIRD_PARTY_PAYMENT]);
test('identity is the stake credential when present, otherwise the payment credential', () => {
  const real =
    'addr_test1qq99squlfgmcgxaphmqydchcwfrxf5wuwgckd7lcfashmtzc5uj7mzanqm7z93xcrhc7se409hcy839khvsy43mn0y9s8u87rz';
  assert.deepEqual(p.identityOf(real), {
    kind: 'stake',
    key: 'stake_test1upv2wf0d3wesdlpzcnvpmu0gv6hjmuzrcjmtkgz2caehjzch5uhyx',
  });
  const enterprise = 'addr_test1vp2tm2edv657xp2as78nkxqausp0s3cwx5vv804r6zlxy9skmt69m';
  assert.deepEqual(p.identityOf(enterprise), {
    kind: 'payment',
    key: '54bdab2d66a9e3055d878f3b181de402f8470e3518c3bea3d0be6216',
  });
  // The key that must sign: the stake key hash inside the stake address, or the payment key hash.
  assert.equal(p.identityKeyHash(real), '58a725ed8bb306fc22c4d81df1e866af2df043c4b6bb204ac773790b');
  assert.equal(p.identityKeyHash(enterprise), '54bdab2d66a9e3055d878f3b181de402f8470e3518c3bea3d0be6216');
  assert.equal(p.identityKeyHash(ORGANIZER.address), ORGANIZER_STAKE.hash);
  assert.equal(p.identityOf(THIRD_PARTY.address).key, p.identityOf(ORGANIZER.address).key);
  assert.throws(() => p.identityOf(`${real.slice(0, -1)}q`), /checksum/);
  const fill = (b) => b.repeat(28);
  assert.throws(() => p.identityOf(bech32(`10${fill('01')}${fill('02')}`)), /key-hash/);
  assert.throws(() => p.identityOf(p.encodeBech32('addr', unhex(`01${fill('01')}${fill('02')}`))), /preprod/);
});
test('the pinned preprod slot clock matches the indexer for a real transaction', () => {
  // Koios tx_cbor for 3883c2a9: absolute_slot 136605785, tx_timestamp 1792288985 (read 2026-10-18).
  assert.equal(p.preprodSlotTime(136605785n), 1792288985);
  assert.equal(p.preprodSlotAt(1792288985), 136605785n);
  assert.throws(() => p.preprodSlotTime(86399n), /slot clock/);
});
// A Koios mock over a fixed set of transactions. Each listed transaction is enumerated for `stake`; its raw CBOR,
// metadata JSON (`json` overrides what the indexer claims), inputs, inclusion and confirmation time are served
// from the same record. `tx_info` also answers with inclusion data, as the pre-CBOR implementation read it.
function chainOf(txs, stake = p.identityOf(ORGANIZER.address).key, calls = []) {
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
    if (endpoint === 'tx_metadata' || endpoint === 'tx_cbor') {
      assert.ok(body._tx_hashes.length <= 50, 'Koios rejects bodies over 5 KiB');
      return byHash(body).map((t) =>
        endpoint === 'tx_metadata'
          ? { tx_hash: t.txHash, metadata: { [t.label ?? p.LABEL]: t.json ?? t.metadata } }
          : { tx_hash: t.txHash, cbor: t.cbor, block_height: t.blockHeight, tx_timestamp: t.blockTime },
      );
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
// One committed draw: its bundle, the proof the organizer publishes and the signed transaction the chain holds.
// By default the transaction is what the page builds: the wallet's identity key as the only required signer,
// witnesses from all of the wallet's keys, and invalid_hereafter at commitmentValidUntil(round).
const R = p.FIXTURE.round;
const T = p.roundTime(R);
// A real quicknet beacon for a second round, fetched from api.drand.sh on 2026-10-19 and verified below.
const BEACON_2 = {
  round: 1000400,
  randomness: '2ada6b787bba749d616a35229c3e06f3e66a78e645a73d004e2e806077d1833f',
  signature: 'b3cc72874340092d770c77fef11d63a7c28567ac2a7bb76aa8ddd23810d5880e2a5036bd560de615affb9c59330c897c',
};
async function draw({
  drawId,
  round = R,
  blockTime,
  blockHeight,
  from = ORGANIZER,
  beacon = p.FIXTURE,
  label = p.LABEL,
  validUntil = p.commitmentValidUntil(round),
  signers = [p.identityKeyHash(from.address)],
  witnesses = from.keys,
  ...options
}) {
  const b = { ...bundle(), drawId, drand: { chainHash: p.QUICKNET, round } };
  const metadata = p.commitmentMetadata(b, await p.computeCommitment(b));
  const built = buildTransaction({
    label,
    metadata,
    signers,
    witnesses,
    invalidHereafter: validUntil === null ? null : p.preprodSlotAt(validUntil),
    input: await p.sha256(`${drawId}:${round}:${blockHeight}:${from.address}`),
    address: from.hex,
    ...options,
  });
  const tx = { ...built, label, inputs: [from.address], metadata, blockHeight, blockTime };
  const proof = {
    format: 'giveaway-proof-2',
    network: 'preprod',
    bundle: b,
    txHash: built.txHash,
    owner: from.address,
    beacon,
    winners: await p.selectWinners(b, beacon.randomness),
  };
  return { tx, proof };
}
const verify = (d, txs) => p.verifyProof(d.proof, { chain: chainOf(txs.map((x) => x.tx)) });
const check = (v, name) => v.checks.find((c) => c.name === name);
const uniqueness = (v) => check(v, 'Unique commitment');
const target = (options = {}) => draw({ drawId: 'example-1', blockTime: T - 900, blockHeight: 1000, ...options });
test('Koios reads the transaction CBOR, the historical 15th block and verifies organizer input', async () => {
  const a = await target(),
    calls = [];
  const chain = chainOf([a.tx], undefined, calls);
  const confirmed = await chain.readCommitment(a.tx.txHash, ORGANIZER.address);
  assert.equal(confirmed.confirmedAt, T - 600);
  assert.equal(confirmed.validUntil, T - 300);
  assert.equal(confirmed.bundleHash, a.tx.metadata.bundleHash);
  assert.ok(calls.includes('tx_cbor') && !calls.includes('tx_metadata'), 'the target is read from CBOR only');
  assert.ok(calls.includes(`blocks?block_height=eq.${1000 + 14}&limit=1`));
  // Same stake key, so the signature matches, but this address is not where the transaction spends from.
  await assert.rejects(chain.readCommitment(a.tx.txHash, ORGANIZER_2.address), /not a transaction input/);
  await assert.rejects(chain.readCommitment('cd'.repeat(32), ORGANIZER.address), p.NotIndexedError);
});
test('F7: commitments under the CIP-20 message label 674 are not supported', async () => {
  assert.notEqual(p.LABEL, 674);
  const a = await target({ label: 674 });
  await assert.rejects(chainOf([a.tx]).readCommitment(a.tx.txHash, ORGANIZER.address), /Unsupported commitment/);
});
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
test('F1 overlap: same wallet committing from another payment address fails', async () => {
  // Signed by the organizer's stake key from a second payment address: the identity is the key, not the address.
  const a = await target();
  const b = await draw({ drawId: 'example-2', blockTime: T - 600, blockHeight: 1100, from: ORGANIZER_2 });
  const v = await verify(a, [a, b]);
  assert.equal(v.status, 'FAIL');
  assert.deepEqual(
    v.conflicts.map((c) => c.txHash),
    [b.tx.txHash],
  );
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
  // Listed under the organizer's stake address, interval overlapping, signed with the third party's own key;
  // the second one even names the organizer's stake key as required signer but cannot add its witness.
  const own = await draw({ drawId: 'example-2', blockTime: T - 600, blockHeight: 1100, from: THIRD_PARTY });
  const claimed = await draw({
    drawId: 'example-3',
    blockTime: T - 500,
    blockHeight: 1101,
    from: THIRD_PARTY,
    signers: [ORGANIZER_STAKE.hash],
  });
  const v = await verify(a, [a, own, claimed]);
  assert.equal(v.status, 'PASS');
  assert.deepEqual(v.conflicts, []);
  // Neither passes as the organizer's commitment: no organizer key signed it.
  for (const forged of [own, claimed])
    assert.equal(
      (await verify({ ...forged, proof: { ...forged.proof, owner: ORGANIZER.address } }, [forged])).status,
      'FAIL',
    );
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
  const chain = chainOf([incoming.tx, a.tx], p.identityOf(ORGANIZER.address).key, calls);
  const candidates = await chain.findCommitments(ORGANIZER.address);
  assert.deepEqual(candidates, [inclusion(a)]);
  assert.ok(
    calls.every((c) => !c.startsWith('blocks') && c !== 'tx_info'),
    'History needs neither confirmation blocks nor input addresses',
  );
  // An enterprise address has no stake part and is enumerated by its payment credential.
  const enterprise = bech32(addressHex('11'.repeat(28)));
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
  await assert.rejects(chain.findCommitments(ORGANIZER.address), /exceeds development query limit/);
  assert.equal(calls.length, 5);
});
// A bundle the organizer did not commit, with its winners recomputed so only the chain evidence can expose it.
async function tampered(d) {
  const b = { ...d.proof.bundle, entrants: [...d.proof.bundle.entrants, 'mallory'] };
  const proof = { ...d.proof, bundle: b, winners: await p.selectWinners(b, d.proof.beacon.randomness) };
  return { proof, metadata: p.commitmentMetadata(b, await p.computeCommitment(b)) };
}
test('F2: indexer metadata JSON differing from the transaction CBOR fails', async () => {
  const a = await target();
  const forged = await tampered(a);
  // The indexer reports the tampered bundle's hash as metadata; the raw transaction is unchanged.
  const lying = { ...a.tx, json: forged.metadata };
  const v = await p.verifyProof(forged.proof, { chain: chainOf([lying]) });
  assert.equal(v.status, 'FAIL');
  assert.equal(check(v, 'Commitment hash').result, 'fail');
  // The genuine proof still passes against the same lying indexer: the metadata is read from the CBOR.
  assert.equal((await p.verifyProof(a.proof, { chain: chainOf([lying]) })).status, 'PASS');
});
test('F2: auxiliary data replaced under an unchanged transaction body fails', async () => {
  const a = await target();
  const forged = await tampered(a);
  // Swapping the auxiliary data keeps the body, the transaction id and the witnesses valid; only the body's
  // declared auxiliary data hash ties the metadata to the signed transaction.
  const swapped = { ...replaceAuxiliary(a.tx, p.LABEL, forged.metadata), json: forged.metadata };
  assert.equal(p.transactionHash(swapped.cbor), a.tx.txHash);
  await assert.rejects(chainOf([swapped]).readCommitment(a.tx.txHash, ORGANIZER.address), /auxiliary data hash/);
  const v = await p.verifyProof(forged.proof, { chain: chainOf([swapped]) });
  assert.equal(v.status, 'FAIL');
  assert.equal(check(v, 'Cardano evidence').result, 'fail');
});
test('F2: one changed CBOR byte fails', async () => {
  const a = await target();
  // The last byte of the spent input's transaction id, inside the body.
  const input = a.tx.cbor.indexOf('5820') + 4 + 62;
  const flip = (hex, at) =>
    `${hex.slice(0, at)}${(parseInt(hex.slice(at, at + 2), 16) ^ 1).toString(16).padStart(2, '0')}${hex.slice(at + 2)}`;
  const changed = { ...a.tx, cbor: flip(a.tx.cbor, input) };
  await assert.rejects(chainOf([changed]).readCommitment(a.tx.txHash, ORGANIZER.address), /does not match its hash/);
  assert.equal((await verify({ ...a, tx: changed }, [{ tx: changed }])).status, 'FAIL');
});
test('PD3 witness: a missing, corrupted, foreign or unlisted identity signature fails', async () => {
  const cases = {
    'no identity witness': { witnesses: [ORGANIZER_PAYMENT] },
    'corrupted signature': { corruptSignature: true },
    'another key signs': { witnesses: [ORGANIZER_PAYMENT, THIRD_PARTY_PAYMENT] },
    'identity not a required signer': { signers: [ORGANIZER_PAYMENT.hash] },
  };
  for (const [name, options] of Object.entries(cases)) {
    const a = await target(options);
    await assert.rejects(
      chainOf([a.tx]).readCommitment(a.tx.txHash, ORGANIZER.address),
      /did not sign the commitment/,
      name,
    );
    const v = await verify(a, [a]);
    assert.equal(v.status, 'FAIL', name);
    // Not counted in the history either, so the referenced commitment is missing from it.
    assert.deepEqual(await chainOf([a.tx]).findCommitments(ORGANIZER.address), [], name);
  }
  assert.equal((await verify(await target(), [await target()])).status, 'PASS');
});
test('F17: invalid_hereafter missing or not before the round fails', async () => {
  const timing = (v) => check(v, 'Timing and confirmations');
  for (const [name, validUntil] of [
    ['missing', null],
    ['at the round', T],
    ['after the round', T + 60],
    ['before the indexer-reported inclusion', T - 900],
  ]) {
    const a = await target({ validUntil });
    const v = await verify(a, [a]);
    assert.equal(v.status, 'FAIL', name);
    assert.equal(timing(v).result, 'fail', name);
    assert.match(timing(v).detail, /later round/, name);
  }
  const early = await target({ validUntil: T - 1 });
  assert.equal((await verify(early, [early])).status, 'PASS');
});
test('a phase-2 failed transaction is not a commitment', async () => {
  const a = await target({ valid: false });
  await assert.rejects(chainOf([a.tx]).readCommitment(a.tx.txHash, ORGANIZER.address), /Invalid transaction/);
  assert.deepEqual(await chainOf([a.tx]).findCommitments(ORGANIZER.address), []);
});
test('Shelley encodings (plain arrays, bare metadata map, no is_valid) read the same as Conway', async () => {
  const a = await target({ legacy: true });
  assert.ok(a.tx.cbor.startsWith('83'));
  const v = await verify(a, [a]);
  assert.equal(v.status, 'PASS', JSON.stringify(v.checks));
});
const TRANSACTIONS = JSON.parse(await readFile(new URL('./transactions.json', import.meta.url)));
const fixture = (name) => TRANSACTIONS.find((x) => x.name === name).cbor;
test('Node and Python compute the same transaction and auxiliary data hashes for the shared fixtures', () => {
  // tools/reference.py --check recomputes the same fields from the same bytes with its own CBOR walker.
  assert.equal(TRANSACTIONS.length, 6);
  for (const t of TRANSACTIONS) {
    assert.equal(p.transactionHash(t.cbor), t.txHash, t.name);
    const aux = p.auxiliaryDataHash(t.cbor);
    assert.equal(aux.computed, t.auxiliaryDataHash, t.name);
    assert.equal(aux.declared, t.auxiliaryDataHash, t.name);
  }
});
test('a real preprod required signer witness verifies; a changed signature does not', () => {
  const tx = fixture('preprod-05aba404');
  const parts = p.transactionParts(tx);
  const [signer] = p.requiredSigners(parts.body);
  assert.equal(parts.body.get(14).tag, 258);
  assert.deepEqual([...p.verifiedSigners(parts)], [signer]);
  // Flip one byte of every 64-byte signature in the witness set (it follows the body, so the id is unchanged).
  const witnessStart = parts.transaction.spans[1][0] * 2;
  const changed =
    tx.slice(0, witnessStart) +
    tx.slice(witnessStart).replace(/5840(..)/g, (_, b) => `5840${(parseInt(b, 16) ^ 1).toString(16).padStart(2, '0')}`);
  assert.equal(p.transactionHash(changed), p.transactionHash(tx));
  assert.deepEqual([...p.verifiedSigners(p.transactionParts(changed))], []);
});
test('trust-path reader hashes the raw body and auxiliary data bytes of a preprod transaction', () => {
  const PREPROD_TX = fixture('preprod-3883c2a9');
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
// epoch 316 parameters, round 1000400); generated by running the bundled page module against a mock wallet.
const UNSIGNED = fixture('unsigned-evolution');
const ORGANIZER_HEX = `00${'11'.repeat(28)}${'22'.repeat(28)}`;
const UNSIGNED_BUNDLE = {
  ...bundle(['alice', 'bob']),
  drawId: '6f1c9a52-8d3e-4b7a-9c21-0e5d4f3a2b10',
  rules: { winners: 1 },
  drand: { chainHash: p.QUICKNET, round: 1000400 },
};
const plan = async () => ({
  input: { txHash: '3c'.repeat(32), index: 3, lovelace: 25000000n },
  address: ORGANIZER_HEX,
  metadata: p.commitmentMetadata(UNSIGNED_BUNDLE, await p.computeCommitment(UNSIGNED_BUNDLE)),
  signer: '22'.repeat(28),
  invalidHereafter: p.preprodSlotAt(p.commitmentValidUntil(1000400)),
});
const swap = (from, to, nth = 0) => {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = UNSIGNED.indexOf(from, at + 1);
  assert.ok(at >= 0, `fixture lacks ${from}`);
  return UNSIGNED.slice(0, at) + to + UNSIGNED.slice(at + from.length);
};
test('unsigned commitment re-read accepts the planned transaction', async () => {
  const checked = p.checkCommitmentTransaction(UNSIGNED, await plan());
  assert.equal(checked.fee, 186621n);
  assert.equal(checked.txHash, p.transactionHash(UNSIGNED));
});
test('unsigned commitment re-read: input', async () => {
  const base = await plan();
  assert.throws(
    () => p.checkCommitmentTransaction(UNSIGNED, { ...base, input: { ...base.input, index: 2 } }),
    /unexpected input/,
  );
  const other = { ...base, input: { ...base.input, txHash: '3d'.repeat(32) } };
  assert.throws(() => p.checkCommitmentTransaction(UNSIGNED, other), /unexpected input/);
});
test('unsigned commitment re-read: transfer output', async () => {
  const base = await plan();
  assert.throws(() => p.checkCommitmentTransaction(swap('1a001e8480', '1a001e8481'), base), /transfer output/);
  assert.throws(
    () => p.checkCommitmentTransaction(UNSIGNED, { ...base, address: `00${'33'.repeat(56)}` }),
    /transfer output/,
  );
});
test('unsigned commitment re-read: change address', async () => {
  // The second occurrence of the organizer address is the change output.
  const elsewhere = swap(ORGANIZER_HEX, `00${'11'.repeat(28)}${'44'.repeat(28)}`, 1);
  const base = await plan();
  assert.throws(() => p.checkCommitmentTransaction(elsewhere, base), /change to another address/);
});
test('unsigned commitment re-read: balance, fields and witnesses', async () => {
  const base = await plan();
  assert.throws(() => p.checkCommitmentTransaction(swap('1a015c1ac3', '1a015c1ac2'), base), /does not balance/);
  // Body map grows by one field (validity start, key 8).
  assert.throws(() => p.checkCommitmentTransaction(swap('84a6', '84a70800'), base), /unexpected body field 8/);
  assert.throws(
    () => p.checkCommitmentTransaction(swap('a0f5d90103', 'a10080f5d90103'), base),
    /already carries witnesses/,
  );
});
test('unsigned commitment re-read: metadata', async () => {
  const base = await plan();
  const draw = { ...base, metadata: { ...base.metadata, drawId: 'another-draw' } };
  assert.throws(() => p.checkCommitmentTransaction(UNSIGNED, draw), /metadata differs/);
  const round = { ...base, metadata: { ...base.metadata, round: 1000401 } };
  assert.throws(() => p.checkCommitmentTransaction(UNSIGNED, round), /metadata differs/);
  // Changing the on-chain round without updating body field 7 is an auxiliary data hash mismatch.
  assert.throws(() => p.checkCommitmentTransaction(swap('1a000f43d0', '1a000f43d1'), base), /auxiliary data hash/);
});
test('unsigned commitment re-read: required signers', async () => {
  const base = await plan();
  const signer = `581c${'22'.repeat(28)}`;
  assert.throws(
    () => p.checkCommitmentTransaction(swap(signer, `581c${'22'.repeat(27)}23`), base),
    /required signers differ/,
  );
  assert.throws(
    () => p.checkCommitmentTransaction(swap(`d9010281${signer}`, `d9010282${signer}581c${'33'.repeat(28)}`), base),
    /required signers differ/,
  );
  assert.throws(() => p.checkCommitmentTransaction(UNSIGNED, { ...base, signer: '11'.repeat(28) }), /required signers/);
});
test('unsigned commitment re-read: validity upper bound', async () => {
  const base = await plan();
  assert.throws(() => p.checkCommitmentTransaction(swap('031a026432e8', '031a026432e9'), base), /validity upper bound/);
  const later = { ...base, invalidHereafter: base.invalidHereafter - 1n };
  assert.throws(() => p.checkCommitmentTransaction(UNSIGNED, later), /validity upper bound/);
});
