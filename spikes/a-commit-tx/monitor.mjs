import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { matchCommitment, confirmations } from './metadata.mjs';
const samplePath = process.argv[2];
if (!samplePath) throw new Error('Usage: node monitor.mjs <downloaded-sample.json>');
const sample = JSON.parse(await readFile(samplePath, 'utf8'));
if (!/^[a-f0-9]{64}$/.test(sample.txHash) || !Number.isFinite(Date.parse(sample.submittedAt))) {
  throw new Error('Invalid sample');
}
const base = 'https://preprod.koios.rest/api/v1';
let requests = 0;
async function query(endpoint, body) {
  requests++;
  const response = await fetch(`${base}/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status}`);
  return response.json();
}
const started = Date.now();
const report = { ...sample, observations: [], reached: {}, metadataMatch: false };
let checkedMetadata = false;
while (Date.now() - started < 60 * 60 * 1000) {
  const info = (await query('tx_info', { _tx_hashes: [sample.txHash] }))[0];
  if (info) {
    if (!checkedMetadata) {
      const row = (await query('tx_metadata', { _tx_hashes: [sample.txHash] }))[0];
      const actual = row?.metadata?.[String(sample.label)];
      if (!matchCommitment(sample.metadata, actual)) throw new Error('STOP: metadata mismatch or unsupported response shape');
      report.metadataMatch = true;
      report.onChain = { blockHeight: info.block_height, blockTime: info.tx_timestamp,
        txSize: info.tx_size, feeLovelace: info.fee };
      checkedMetadata = true;
    }
    const tip = (await query('tip'))[0];
    const count = confirmations(tip.block_no ?? tip.block_height, info.block_height);
    const seconds = (Date.now() - Date.parse(sample.submittedAt)) / 1000;
    report.observations.push({ time: new Date().toISOString(), confirmations: count, seconds });
    for (const threshold of [1, 5, 15]) if (count >= threshold && report.reached[threshold] === undefined) {
      report.reached[threshold] = seconds;
    }
    console.log(JSON.stringify({ confirmations: count, seconds, requests }));
    if (count >= 15) break;
  }
  await delay(30000);
}
report.requests = requests;
report.complete = [1, 5, 15].every(k => report.reached[k] !== undefined) && report.metadataMatch;
await writeFile(`${samplePath}.observed.json`, JSON.stringify(report, null, 2));
if (!report.complete) process.exitCode = 1;
