// Experimental spike format, not protocol v1 or a registered metadata label.
export const LABEL = 674;
export const QUICKNET = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export function splitUtf8(value, maxBytes = 64) {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error('Invalid chunk limit');
  const result = [];
  let chunk = '';
  for (const char of value) {
    if (new TextEncoder().encode(chunk + char).length > maxBytes) {
      result.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) result.push(chunk);
  return result;
}
export function commitmentMetadata({ drawId, bundleHash, round }) {
  if (!/^[a-f0-9]{64}$/.test(bundleHash)) throw new Error('Invalid bundle hash');
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('Invalid round');
  if (!drawId || new TextEncoder().encode(drawId).length > 64) throw new Error('Invalid drawId');
  return { protocol: 'spike-a-0', drawId, bundleHash, chainHash: QUICKNET, round,
    utf8Probe: splitUtf8('測'.repeat(23)) };
}
export function matchCommitment(expected, actual) {
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) =>
    JSON.stringify(actual[key]) === JSON.stringify(value));
}
export function confirmations(tipHeight, inclusionHeight) {
  if (!Number.isSafeInteger(tipHeight) || !Number.isSafeInteger(inclusionHeight)) {
    throw new Error('Invalid block heights');
  }
  return Math.max(0, tipHeight - inclusionHeight + 1);
}
