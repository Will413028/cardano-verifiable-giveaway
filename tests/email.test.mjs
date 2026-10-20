import test from 'node:test';
import assert from 'node:assert/strict';
const p = await import('@giveaway/verifier-cli/library');

// Plan step 10b: normalizeLabel's email check was the pattern below, which backtracks quadratically on "a@" followed by
// dots and a final "@" (PD2). It is now decided by `emailShaped` in linear time. The former pattern stays here as the
// oracle: every expected value below is its answer, never one computed by the new code.
const ORACLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const agree = (label) => {
  const expected = ORACLE.test(label);
  if (p.emailShaped(label) !== expected)
    assert.fail(`emailShaped(${JSON.stringify(label)}) differs from the former pattern (${expected})`);
  return expected;
};

// A seeded generator (mulberry32), so a failure reproduces.
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// Every UTF-16 code unit JavaScript's `\s` matches, read from the engine itself (not a hand-written list, which would
// carry another engine's idea of whitespace): U+0009–U+000D, U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029,
// U+202F, U+205F, U+3000, U+FEFF.
const WHITESPACE = [];
for (let u = 0; u <= 0xffff; u++) if (/\s/.test(String.fromCharCode(u))) WHITESPACE.push(String.fromCharCode(u));

test('emailShaped agrees with the former email pattern on every string of up to 6 units over a mixed alphabet', () => {
  // Letters, the two separators, whitespace of several kinds (ASCII, no-break, line separator, BOM), a lone high and a
  // lone low surrogate, and a non-whitespace format character (U+200B is not `\s`).
  const alphabet = ['a', '@', '.', ' ', '\u00a0', '\u2028', '\ufeff', '\ud800', '\udc00', '\u200b'];
  let matched = 0;
  let total = 0;
  const walk = (prefix, depth) => {
    total++;
    if (agree(prefix)) matched++;
    if (depth === 0) return;
    for (const c of alphabet) walk(prefix + c, depth - 1);
  };
  walk('', 6);
  // The space covers both answers (the empty string up to every 6-unit combination).
  assert.equal(total, 1_111_111);
  assert.ok(matched > 1000);
});

test('emailShaped agrees with the former email pattern for every code unit in every position of an address', () => {
  const positions = [
    (c) => `${c}a@b.c`,
    (c) => `a${c}@b.c`,
    (c) => `a@${c}b.c`,
    (c) => `a@b${c}.c`,
    (c) => `a@b.${c}c`,
    (c) => `a@b.c${c}`,
    (c) => `${c}@b.c`,
    (c) => `a@${c}.c`,
    (c) => `a@b.${c}`,
    (c) => `a@b${c}c`,
  ];
  let rejected = 0;
  for (let u = 0; u <= 0xffff; u++) {
    const c = String.fromCharCode(u);
    for (const at of positions) if (!agree(at(c))) rejected++;
  }
  // Whitespace and "@" are refused wherever they stand; the counts come from the oracle's answers.
  assert.ok(rejected > WHITESPACE.length * 6);
  // Astral characters (surrogate pairs) are two ordinary code units to the pattern.
  for (const c of ['\u{1f600}', '\u{1d51e}', '\u{10ffff}']) for (const at of positions) agree(at(c));
});

test('emailShaped agrees with the former email pattern on backtracking constructions', () => {
  const shapes = [
    (k) => `a@${'.'.repeat(k)}@`,
    (k) => `a@${'.'.repeat(k)}`,
    (k) => `a@${'.'.repeat(k)}a`,
    (k) => `a@a${'.'.repeat(k)}`,
    (k) => `a@a${'.'.repeat(k)}a`,
    (k) => `a@${'b.'.repeat(k)}@`,
    (k) => `a@${'b.'.repeat(k)} `,
    (k) => `a@${'.'.repeat(k)}\u2028`,
    (k) => `${'a'.repeat(k)}@${'.'.repeat(k)}`,
    (k) => `${'a'.repeat(k)}@`,
    (k) => `@${'a.'.repeat(k)}`,
    (k) => `a@b${'.'.repeat(k)}c@`,
  ];
  for (let k = 0; k <= 200; k++) for (const shape of shapes) agree(shape(k));
  // The label the PD2 measurement used (200 units, refused only after backtracking over every dot).
  assert.equal(agree(`a@${'.'.repeat(192)}00001@`), false);
});

test('emailShaped agrees with the former email pattern on 200,000 seeded random strings', () => {
  const next = random(20261020);
  const pieces = ['a', 'Z', '0', 'a', 'b', '@', '.', '.', '-', '_', '+', '中', '😀'];
  const pick = (xs) => xs[Math.floor(next() * xs.length)];
  let matched = 0;
  for (let i = 0; i < 200_000; i++) {
    const length = Math.floor(next() * 24);
    let label = '';
    for (let j = 0; j < length; j++) {
      const r = next();
      // Mostly address-like pieces; now and then whitespace of any kind or any code unit (lone surrogates included).
      label +=
        r < 0.02 ? pick(WHITESPACE) : r < 0.04 ? String.fromCharCode(Math.floor(next() * 0x10000)) : pick(pieces);
    }
    if (agree(label)) matched++;
  }
  // Both answers occur often (counted from the oracle's answers).
  assert.ok(matched > 1000 && matched < 199_000, `${matched} matched`);
});

test('normalizeLabel refuses exactly the labels the former email pattern matched', () => {
  const next = random(7);
  let emails = 0;
  const pieces = ['a', 'b', '@', '.', '.', ' ', '\u00a0', '\u3000', '中'];
  for (let i = 0; i < 50_000; i++) {
    let label = 'x';
    const length = Math.floor(next() * 12);
    for (let j = 0; j < length; j++) label += pieces[Math.floor(next() * pieces.length)];
    label += 'y';
    const expected = ORACLE.test(label.trim().normalize('NFC'));
    let refused = false;
    try {
      p.normalizeLabel(label);
    } catch (e) {
      refused = /not an email/.test(e.message);
    }
    assert.equal(refused, expected, JSON.stringify(label));
    if (expected) emails++;
  }
  assert.ok(emails > 100 && emails < 49_000, `${emails} email-shaped`);
});

// Linear time without a timing assertion: every regular expression label normalization executes is recorded through
// RegExp.prototype.exec (RegExp.prototype.test, match and search all go through it once it is replaced) and must be one
// of the patterns below, each a single character class, unquantified or quantified once and anchored at both ends, so
// it runs in linear time. Putting the former email pattern back (in emailShaped or in normalizeLabel) fails here
// deterministically. The CPU readings against the label count are in apps/api/bench (cpu-report*.json).
const LINEAR = new Set(
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control-character pattern normalizeLabel uses.
  [/\s/, /[\u0000-\u001f\u007f-\u009f]/, /[\ud800-\udfff]/u, /^\+?[\d\s()-]{7,}$/].map((x) => x.source),
);
test('label normalization runs no backtracking pattern (linear time)', () => {
  const executed = new Set();
  const exec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (...args) {
    executed.add(this.source);
    return exec.apply(this, args);
  };
  try {
    for (const label of [`a@${'.'.repeat(192)}00001@`, 'a@b.c', 'a b@c.d', 'alice', '+1 234 567 890']) {
      p.emailShaped(label);
      try {
        p.normalizeLabel(label);
      } catch {}
    }
  } finally {
    RegExp.prototype.exec = exec;
  }
  for (const source of executed) assert.ok(LINEAR.has(source), `label normalization ran /${source}/`);
  assert.ok(executed.has('\\s'), 'the recording saw the whitespace scan');
});
