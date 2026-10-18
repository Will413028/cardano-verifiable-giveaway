export const VERSION = 'development-1';
export const ALGORITHM = 'sha256-ranking-1';
export const QUICKNET = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const GENESIS = 1692803367;
export const PERIOD = 3;
export const CONFIRMATIONS = 15;
export const BOUNDARY =
  'Verification covers selection from the committed list. It does not establish entrant eligibility, list completeness or prize delivery. Cross-address or different-drawId commitments cannot be ruled out.';

export interface Bundle {
  version: typeof VERSION;
  algorithm: typeof ALGORITHM;
  drawId: string;
  entrants: string[];
  rules: { winners: number };
  drand: { chainHash: string; round: number };
}
export interface Beacon {
  round: number;
  signature: string;
  randomness: string;
}
export interface Commitment {
  txHash: string;
  owner: string;
  bundleHash: string;
  drawId: string;
  round: number;
  blockHeight: number;
  blockTime: number;
  confirmedAt: number;
}
export interface Proof {
  format: 'giveaway-proof-1';
  network: 'demo' | 'preprod';
  bundle: Bundle;
  commitment: Commitment;
  beacon: Beacon;
  winners: string[];
}
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function unhex(value: string): Uint8Array {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) throw new Error('Invalid hexadecimal bytes');
  return Uint8Array.from(value.match(/../g) ?? [], (b) => parseInt(b, 16));
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== keys.sort().join('|')
  )
    throw new Error(`Expected exactly: ${keys.join(', ')}`);
}
export function normalizeLabel(value: string): string {
  const label = value.trim().normalize('NFC');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected on purpose.
  if (!label || label.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(label) || /[\ud800-\udfff]/u.test(label))
    throw new Error('Invalid participant label');
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(label) || /^\+?[\d\s()-]{7,}$/.test(label))
    throw new Error('Use a public participant label, not an email or phone number');
  return label;
}
export function validateBundle(value: unknown): Bundle {
  object(value, ['version', 'algorithm', 'drawId', 'entrants', 'rules', 'drand']);
  if (value.version !== VERSION || value.algorithm !== ALGORITHM)
    throw new Error('Unsupported development protocol or algorithm');
  if (typeof value.drawId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.drawId))
    throw new Error('Invalid drawId');
  if (!Array.isArray(value.entrants) || value.entrants.length < 1 || value.entrants.length > 10000)
    throw new Error('Use 1–10,000 participants');
  const entrants = value.entrants.map((x) => {
    if (typeof x !== 'string') throw new Error('Participant labels must be strings');
    return normalizeLabel(x);
  });
  if (entrants.some((x, i) => x !== (value.entrants as string[])[i]))
    throw new Error('Labels must already be trimmed and Unicode NFC');
  if (new Set(entrants).size !== entrants.length) throw new Error('Duplicate participant labels are not allowed');
  object(value.rules, ['winners']);
  object(value.drand, ['chainHash', 'round']);
  if (
    !Number.isSafeInteger(value.rules.winners) ||
    Number(value.rules.winners) < 1 ||
    Number(value.rules.winners) > entrants.length
  )
    throw new Error('Invalid winner count');
  if (value.drand.chainHash !== QUICKNET || !Number.isSafeInteger(value.drand.round) || Number(value.drand.round) < 1)
    throw new Error('Invalid quicknet round');
  return value as unknown as Bundle;
}
export function canonicalize(value: unknown): string {
  if (typeof value === 'string') {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected on purpose.
    if (/[\u0000-\u001f]/.test(value) || /[\ud800-\udfff]/u.test(value)) throw new Error('Invalid canonical string');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${canonicalize(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  throw new Error('Unsupported canonical JSON value');
}
export async function computeCommitment(bundle: Bundle): Promise<string> {
  return sha256(canonicalize(validateBundle(bundle)));
}
export function roundTime(round: number): number {
  return GENESIS + (round - 1) * PERIOD;
}
export function roundAt(time: number): number {
  return Math.floor((time - GENESIS) / PERIOD) + 1;
}
export async function selectWinners(bundle: Bundle, randomness: string): Promise<string[]> {
  validateBundle(bundle);
  if (!/^[a-f0-9]{64}$/.test(randomness)) throw new Error('Invalid randomness');
  const hash = await computeCommitment(bundle);
  const seed = await sha256(unhex(randomness + hash));
  const ranked = await Promise.all(
    bundle.entrants.map(async (label, index) => {
      const bytes = new Uint8Array([...unhex(seed), ...new TextEncoder().encode(label)]);
      return { label, index, score: await sha256(bytes) };
    }),
  );
  ranked.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : a.index - b.index));
  return ranked.slice(0, bundle.rules.winners).map((x) => x.label);
}
export function checkTiming(commitment: Commitment, round: number): boolean {
  return (
    Number.isSafeInteger(commitment.blockTime) &&
    Number.isSafeInteger(commitment.confirmedAt) &&
    commitment.blockTime < roundTime(round) &&
    commitment.confirmedAt >= commitment.blockTime &&
    commitment.confirmedAt < roundTime(round)
  );
}
export function checkUniqueness(commitments: Commitment[], target: Commitment): boolean {
  const candidates = commitments.filter((x) => x.owner === target.owner && x.drawId === target.drawId);
  candidates.sort((a, b) => a.blockHeight - b.blockHeight || a.txHash.localeCompare(b.txHash));
  // Same-block ordering is not authoritative; refuse to choose between simultaneous commitments.
  return (
    candidates.length > 0 &&
    candidates[0].txHash === target.txHash &&
    candidates.filter((x) => x.blockHeight === candidates[0].blockHeight).length === 1
  );
}
export function validateProof(value: unknown): Proof {
  object(value, ['format', 'network', 'bundle', 'commitment', 'beacon', 'winners']);
  if (
    value.format !== 'giveaway-proof-1' ||
    typeof value.network !== 'string' ||
    !['demo', 'preprod'].includes(value.network)
  )
    throw new Error('Unsupported proof format or network');
  validateBundle(value.bundle);
  object(value.commitment, [
    'txHash',
    'owner',
    'bundleHash',
    'drawId',
    'round',
    'blockHeight',
    'blockTime',
    'confirmedAt',
  ]);
  object(value.beacon, ['round', 'signature', 'randomness']);
  const c = value.commitment,
    b = value.beacon;
  if (
    typeof c.txHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(c.txHash) ||
    typeof c.bundleHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(c.bundleHash) ||
    typeof c.owner !== 'string' ||
    !c.owner ||
    typeof c.drawId !== 'string'
  )
    throw new Error('Invalid commitment reference');
  for (const key of ['round', 'blockHeight', 'blockTime', 'confirmedAt'])
    if (!Number.isSafeInteger(c[key]) || Number(c[key]) < 0) throw new Error('Invalid commitment timing');
  if (!Number.isSafeInteger(b.round) || typeof b.signature !== 'string' || typeof b.randomness !== 'string')
    throw new Error('Invalid beacon');
  if (!Array.isArray(value.winners) || value.winners.some((x) => typeof x !== 'string'))
    throw new Error('Invalid winners');
  return value as unknown as Proof;
}
export function parseEntrants(text: string): string[] {
  // CSV supports quoted fields and escaped quotes. Only the label column is imported.
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i] ?? '\n';
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted) {
        quoted = false;
        closed = true;
      } else if (!field && !closed) quoted = true;
      else throw new Error('Malformed CSV quoting');
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(field);
      field = '';
      closed = false;
      if (c !== ',') {
        if (row.some((x) => x.trim())) rows.push(row);
        row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
    } else {
      if (closed && !quoted) throw new Error('Malformed CSV quoting');
      field += c;
    }
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  const headers = rows[0]?.map((x) => x.trim().toLowerCase()) ?? [];
  const labelIndex = headers.indexOf('label');
  const data = labelIndex >= 0 ? rows.slice(1) : rows;
  if (labelIndex < 0 && rows.some((r) => r.length !== 1))
    throw new Error('CSV must contain a label header; other columns are discarded');
  const labels = data.map((r) => normalizeLabel(r[labelIndex >= 0 ? labelIndex : 0] ?? ''));
  if (new Set(labels).size !== labels.length) throw new Error('Duplicate participant labels are not allowed');
  if (!labels.length) throw new Error('No participants found');
  return labels;
}
