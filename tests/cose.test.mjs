import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const p = await import('@giveaway/verifier-cli/library');

// CIP-8 COSE_Sign1 verification (packages/chain/cose.ts, moved from the S1 spike with its first caller, plan step 11)
// against the S1 vectors: signatures from an independent RFC 9052 generator and from Evolution SDK and Mesh signData,
// with the negatives S1 defined. A vector holds when the signature verifies AND the verified payload and address are
// the ones the vector names (the spike's verifyCose compared them inside; here the caller does).
const { vectors } = JSON.parse(await readFile(new URL('./cose-vectors.json', import.meta.url)));

test('verifyDataSignature agrees with every S1 COSE vector', () => {
  assert.equal(vectors.length, 29);
  for (const v of vectors) {
    const signed = p.verifyDataSignature({ signature: v.signature, key: v.key });
    const holds = signed !== null && p.hex(signed.payload) === v.payload && p.hex(signed.address) === v.address;
    assert.equal(holds, v.expect, v.id);
  }
});

test('verifyDataSignature returns the signer credential of the address it signed for', () => {
  const valid = vectors.filter((v) => v.expect);
  assert.equal(valid.length, 6);
  for (const v of valid) {
    const signed = p.verifyDataSignature({ signature: v.signature, key: v.key });
    assert.equal(signed.keyHash, p.signingKeyHash(p.unhex(v.address)), v.id);
  }
});

test('verifyDataSignature refuses malformed input without throwing', () => {
  const [v] = vectors;
  for (const [signature, key] of [
    ['', v.key],
    ['zz', v.key],
    [v.signature, ''],
    [v.signature.slice(0, -2), v.key],
    [`d3${v.signature}`, v.key],
  ])
    assert.equal(p.verifyDataSignature({ signature, key }), null);
  // Tag 18 (COSE_Sign1) around the same structure is accepted.
  assert.notEqual(p.verifyDataSignature({ signature: `d2${v.signature}`, key: v.key }), null);
});

test('owner operation text: what is rendered parses back, and nothing else parses', () => {
  const op = {
    domain: '127.0.0.1:4320',
    operation: 'extend',
    network: 'preprod',
    txHash: 'ab'.repeat(32),
    bundleHash: 'cd'.repeat(32),
    nonce: '0f'.repeat(16),
    issuedAt: 1_800_000_000,
  };
  const text = p.ownerOperationText(op);
  assert.equal(
    text,
    [
      'Open Draw owner operation (giveaway-owner-operation-1)',
      'domain: 127.0.0.1:4320',
      'operation: extend',
      'network: preprod',
      `transaction: ${'ab'.repeat(32)}`,
      `bundle: ${'cd'.repeat(32)}`,
      `nonce: ${'0f'.repeat(16)}`,
      'issued: 2027-01-15T08:00:00Z',
      'expires: 2027-01-15T08:05:00Z',
    ].join('\n'),
  );
  assert.deepEqual(p.parseOwnerOperation(text), op);
  for (const changed of [
    `${text}\n`,
    text.replace('expires: 2027-01-15T08:05:00Z', 'expires: 2027-01-15T09:05:00Z'),
    text.replace('operation: extend', 'operation: transfer'),
    text.replace('domain: ', 'domain:  '),
    text.replace('nonce: 0f', 'nonce: 0F'),
    text.replace('issued: 2027-01-15T08:00:00Z', 'issued: 2027-01-15T08:00:00.000Z'),
    text.split('\n').reverse().join('\n'),
    text.replace('Open Draw', 'Closed Draw'),
  ])
    assert.throws(() => p.parseOwnerOperation(changed), /Owner operation/, changed);
});
