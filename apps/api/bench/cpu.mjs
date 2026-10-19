// PD2: CPU time of the upload gate for a 10,000-label bundle of 200-character labels, measured in the local Workers
// runtime (workerd, started by Wrangler's unstable_dev; nothing is deployed). Run from apps/api:
//   node bench/cpu.mjs [repetitions]        (writes bench/cpu-report.json)
// Two readings per variant:
//   - in-isolate: performance.now() around the work inside the Worker (local workerd lets it advance during
//     computation; on Cloudflare it would not, so this Worker is local-only). It is wall time: when the machine is
//     busy with other processes it includes their preemption, so its maximum is noisy;
//   - process: the workerd process's CPU time (user + system, `ps -o cputime`, 10 ms resolution) over the /inspect
//     repetitions divided by their number. It also counts receiving the body, the HTTP layer and concurrent GC threads,
//     so it is an upper bound for the CPU of the same work, and is not inflated by other processes.
// Neither is Cloudflare's billed CPU time: that is measured on Cloudflare's hardware and runtime build; the numbers
// here are from this machine (recorded in the report).
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { unstable_dev } from 'wrangler';

const REPETITIONS = Number(process.argv[2] ?? 10);
const ENTRANTS = 10_000;
const UNITS = 200;
const QUICKNET = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
// Label i: `UNITS` UTF-16 units made of a filler and a unique suffix in the same character class, so every label is
// distinct, trimmed, NFC and accepted by validateBundle.
const digits = (i, alphabet) => {
  let out = '';
  for (let n = i, k = 0; k < 5; k++, n = Math.floor(n / alphabet.length)) out = alphabet[n % alphabet.length] + out;
  return out;
};
const DECIMAL = [...'0123456789'];
const VARIANTS = {
  // 1 byte per unit.
  ascii: (i) => 'a'.repeat(UNITS - 5) + digits(i, DECIMAL),
  // 3 bytes per unit: the protocol's worst case for size (BUNDLE_BYTE_LIMIT is derived from it).
  cjk: (i) => '中'.repeat(UNITS - 5) + digits(i, [...'一二三四五六七八九十']),
  // Precomposed Hangul syllables (3 bytes): NFC checks them against the Hangul composition rules.
  hangul: (i) => '한'.repeat(UNITS - 5) + digits(i, [...'가나다라마바사아자차']),
  // A base letter plus a combining dot above that has no precomposed form: NFC must examine every pair.
  combining: (i) => 'q̇'.repeat((UNITS - 6) / 2) + 'q̇'.slice(0, 1) + digits(i, [...'bcdfghjkmp']),
  // One long combining sequence (dot below, class 220, then dot above, class 230, already in canonical order) after a
  // base letter: the longest run NFC has to check and order as one unit.
  longCluster: (i) => `q${'\u0323'.repeat(97)}${'\u0307'.repeat(97)}${digits(i, DECIMAL)}`,
  // An address-like label that the email pattern /^[^\s@]+@[^\s@]+\.[^\s@]+$/ rejects only after backtracking over
  // every dot (quadratic in the label length).
  emailBacktrack: (i) => `a@${'.'.repeat(UNITS - 8)}${digits(i, DECIMAL)}@`,
};
const bundleOf = (label) => ({
  algorithm: 'sha256-ranking-1',
  drand: { chainHash: QUICKNET, round: 1_000_000 },
  drawId: 'pd2-cpu',
  entrants: Array.from({ length: ENTRANTS }, (_, i) => label(i)),
  rules: { winners: 1 },
  version: 'development-2',
});
// Canonical bytes (keys sorted, no whitespace): what the page uploads.
const canonical = (bundle) => JSON.stringify(bundle);

const workerdCpuSeconds = () => {
  const lines = execFileSync('ps', ['-axo', 'pid=,cputime=,command='], { encoding: 'utf8' }).split('\n');
  let total = 0;
  for (const line of lines.filter((l) => /\/workerd\s/.test(l) || /\bworkerd serve\b/.test(l))) {
    const [, , time] = line.trim().match(/^(\d+)\s+(\S+)/) ?? [];
    const parts = time.split(':').map(Number);
    total += parts.reduce((acc, x) => acc * 60 + x, 0);
  }
  return total;
};
const stats = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
};

const root = fileURLToPath(new URL('./', import.meta.url));
const worker = await unstable_dev(`${root}worker.ts`, {
  config: `${root}wrangler.jsonc`,
  ip: '127.0.0.1',
  logLevel: 'error',
  experimental: { disableExperimentalWarning: true, testMode: true },
});
const report = {
  measuredAt: new Date().toISOString(),
  what: 'Upload-gate CPU work in local workerd (Wrangler unstable_dev); see apps/api/bench/cpu.mjs header',
  machine: {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    node: process.version,
  },
  wrangler: (await import('wrangler/package.json', { with: { type: 'json' } })).default.version,
  repetitions: REPETITIONS,
  entrants: ENTRANTS,
  labelUnits: UNITS,
  variants: {},
};
try {
  // Warm-up: the first request compiles the Worker's code paths.
  await worker.fetch('/inspect', { method: 'POST', body: canonical(bundleOf(VARIANTS.ascii)) });
  const post = async (path, body) => {
    const response = await worker.fetch(path, { method: 'POST', body });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  };
  for (const [name, label] of Object.entries(VARIANTS)) {
    const body = canonical(bundleOf(label));
    const runs = [];
    const before = workerdCpuSeconds();
    for (let i = 0; i < REPETITIONS; i++) runs.push(await post('/inspect', body));
    const after = workerdCpuSeconds();
    const steps = [];
    for (let i = 0; i < REPETITIONS; i++) steps.push(await post('/steps', body));
    const pick = (xs, key) => stats(xs.map((r) => r[key]));
    report.variants[name] = {
      bytes: runs[0].bytes,
      inspectMs: pick(runs, 'inspectMs'),
      processCpuMsPerRequest: Math.round(((after - before) * 1000) / REPETITIONS),
      steps: Object.fromEntries(
        ['sha256Ms', 'decodeMs', 'parseMs', 'canonicalMs', 'validateMs'].map((k) => [k, pick(steps, k)]),
      ),
    };
    console.log(name, JSON.stringify(report.variants[name]));
  }
  const chainRuns = [];
  for (let i = 0; i < REPETITIONS; i++) chainRuns.push((await (await worker.fetch('/chain')).json()).chainMs);
  report.chainReadsMs = stats(chainRuns);
  console.log('chain reads', JSON.stringify(report.chainReadsMs));
} finally {
  await worker.stop();
}
const worst = Object.entries(report.variants).sort(
  (a, b) => b[1].processCpuMsPerRequest - a[1].processCpuMsPerRequest,
)[0];
report.worst = {
  variant: worst[0],
  processCpuMsPerRequest: worst[1].processCpuMsPerRequest,
  inspectMs: worst[1].inspectMs,
  chainReadsMsMax: report.chainReadsMs.max,
};
await writeFile(`${root}cpu-report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log('worst', JSON.stringify(report.worst));
