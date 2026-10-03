import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitUtf8, commitmentMetadata, matchCommitment, confirmations } from './metadata.mjs';

test('UTF-8 chunks preserve a multibyte boundary without replacement characters', () => {
  const input = 'a'.repeat(63) + '測😀'.repeat(20);
  const chunks = splitUtf8(input);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every(c => new TextEncoder().encode(c).length <= 64));
});
test('returned metadata must match every committed field, including Unicode probe', () => {
  const expected = commitmentMetadata({ drawId: 'fixture', bundleHash: 'ab'.repeat(32), round: 100 });
  assert.equal(matchCommitment(expected, structuredClone(expected)), true);
  assert.equal(matchCommitment(expected, { ...expected, bundleHash: 'ac' + expected.bundleHash.slice(2) }), false);
  assert.equal(matchCommitment(expected, { ...expected, round: 101 }), false);
  assert.equal(matchCommitment(expected, { ...expected, utf8Probe: ['broken'] }), false);
});
test('inclusion block counts as the first confirmation; a lower tip never gives a negative count', () => {
  assert.equal(confirmations(100, 100), 1);
  assert.equal(confirmations(104, 100), 5);
  assert.equal(confirmations(114, 100), 15);
  assert.equal(confirmations(99, 100), 0);
});
