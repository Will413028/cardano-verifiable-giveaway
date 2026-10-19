// PD2: CPU time of the upload gate as a function of the entrant count n, for each label construction, measured in the
// local Workers runtime (workerd, started by Wrangler's unstable_dev; nothing is deployed). Run from apps/api:
//   node bench/cpu.mjs [--out bench/cpu-report.json] [--n 1,10,100,...] [--budget 4000] [--min-reps 10]
// Each (construction, n) is sent max(min-reps, ceil(budget / n)) times, so small bundles get enough repetitions for the
// process reading's 10 ms resolution. Readings:
//   - process: the CPU time (user + system, `ps -o cputime`, 10 ms resolution) of the workerd processes this script
//     started, over the repetitions, divided by their number. It also counts receiving the body, the local HTTP layer
//     and concurrent GC threads, so it is an upper bound for the CPU of the same work, and is not inflated by other
//     processes. `/noop` (receive the body, answer) gives that per-request overhead alone;
//   - in-isolate: performance.now() around the work inside the Worker (local workerd lets it advance during
//     computation; on Cloudflare it would not, so this Worker is local-only). It is wall time: when the machine is
//     busy with other processes it includes their preemption, so its maximum is noisy; the minimum is the reading
//     least disturbed by them.
// Neither is Cloudflare's billed CPU time: that is measured on Cloudflare's hardware and runtime build; the numbers
// here are from this machine (recorded in the report).
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { unstable_dev } from 'wrangler';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: 'bench/cpu-report.json' },
    n: { type: 'string', default: '1,10,30,100,300,1000,3000,10000' },
    budget: { type: 'string', default: '4000' },
    'min-reps': { type: 'string', default: '10' },
    label: { type: 'string', default: '' },
    gate: { type: 'string', default: '' },
  },
});
const SIZES = args.n.split(',').map(Number);
const BUDGET = Number(args.budget);
const MIN_REPS = Number(args['min-reps']);
const repetitions = (n) => Math.max(MIN_REPS, Math.ceil(BUDGET / n));
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
const LABELS = {
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
  longCluster: (i) => `q${'̣'.repeat(97)}${'̇'.repeat(97)}${digits(i, DECIMAL)}`,
  // An address-like label that the former email pattern /^[^\s@]+@[^\s@]+\.[^\s@]+$/ rejected only after
  // backtracking over every dot (quadratic in the label length).
  emailBacktrack: (i) => `a@${'.'.repeat(UNITS - 8)}${digits(i, DECIMAL)}@`,
  // Quotes and backslashes: two bytes each in the canonical JSON, so JSON.parse and canonicalize handle an escape per
  // unit.
  escapes: (i) => '"\\'.repeat((UNITS - 6) / 2) + digits(i, DECIMAL),
};
const bundleOf = (label, n) => ({
  algorithm: 'sha256-ranking-1',
  drand: { chainHash: QUICKNET, round: 1_000_000 },
  drawId: 'pd2-cpu',
  entrants: Array.from({ length: n }, (_, i) => label(i)),
  rules: { winners: 1 },
  version: 'development-2',
});
// Canonical bytes (keys sorted, no whitespace): what the page uploads.
const canonical = (bundle) => JSON.stringify(bundle);
// Bodies that are not bundles, as large as the CJK bundle of the same n (the most bytes n labels can take): the gate
// spends CPU on them before refusing them, so the byte cap has to bound their cost too.
const NON_BUNDLES = {
  // An object with as many keys as fit: canonicalize sorts them.
  manyKeys: (bytes) => {
    const keys = [];
    for (let i = 0, size = 2; size < bytes; i++) {
      const key = `"${i.toString(36).padStart(8, '0')}":0`;
      keys.push(key);
      size += key.length + 1;
    }
    return `{${keys.join(',')}}`;
  },
  // A bundle whose entrants are as many one-character labels as fit (refused for exceeding the entrant cap, or by
  // validateBundle beyond MAX_ENTRANTS).
  shortLabels: (bytes) => {
    const labels = [];
    for (let i = 0, size = 300; size < bytes; i++) {
      labels.push(JSON.stringify(i.toString(36)));
      size += labels.at(-1).length + 1;
    }
    return canonical(bundleOf((i) => JSON.parse(labels[i]), labels.length));
  },
};

const root = fileURLToPath(new URL('./', import.meta.url));
// The workerd processes started by this script (descendants of this process), so concurrent Wrangler sessions on the
// machine are not counted.
const workerdCpuSeconds = () => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,cputime=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, time, command]) => ({ pid: Number(pid), ppid: Number(ppid), time, command }));
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const mine = (pid) => {
    for (let p = pid; p > 1; p = parent.get(p) ?? 1) if (p === process.pid) return true;
    return false;
  };
  let total = 0;
  for (const row of rows.filter((r) => /workerd/.test(r.command) && mine(r.pid)))
    total += row.time
      .split(':')
      .map(Number)
      .reduce((acc, x) => acc * 60 + x, 0);
  return total;
};
const round3 = (x) => Math.round(x * 1000) / 1000;

const worker = await unstable_dev(`${root}worker.ts`, {
  config: `${root}wrangler.jsonc`,
  ip: '127.0.0.1',
  logLevel: 'error',
  experimental: { disableExperimentalWarning: true, testMode: true },
});
const report = {
  measuredAt: new Date().toISOString(),
  label: args.label,
  what: 'Upload-gate CPU work in local workerd (Wrangler unstable_dev) against the entrant count; see apps/api/bench/cpu.mjs header',
  machine: {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    node: process.version,
    loadAverage: os.loadavg().map(round3),
  },
  wrangler: (await import('wrangler/package.json', { with: { type: 'json' } })).default.version,
  labelUnits: UNITS,
  budget: BUDGET,
  minRepetitions: MIN_REPS,
  sizes: SIZES,
  constructions: {},
};
// The work in a body, in labels, for sizing in-isolate batches: its entrant count, or for a non-bundle its size in
// 600-byte units (about one 200-unit CJK label).
const labelsOf = (body) => {
  const bytes = Math.ceil(Buffer.byteLength(body) / 600);
  try {
    return Math.max(1, bytes, JSON.parse(body).entrants?.length ?? 1);
  } catch {
    return Math.max(1, bytes);
  }
};
const post = async (path, body) => {
  const response = await worker.fetch(path, { method: 'POST', body });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
};
// Over `reps` requests to `path`: the process CPU per request, and (when `key` names the Worker's in-isolate reading)
// the in-isolate time per run, read as the least of five requests that each repeat the work up to `reps` times
// (`?k=`), the batch least disturbed by other processes.
async function measure(path, body, reps, key) {
  let first;
  const before = workerdCpuSeconds();
  for (let i = 0; i < reps; i++) {
    const answer = await post(path, body);
    first ??= answer;
  }
  const after = workerdCpuSeconds();
  const result = { repetitions: reps, processCpuMsPerRequest: round3(((after - before) * 1000) / reps) };
  if (key) {
    const batches = [];
    // At most 500 runs per request (50 with chain reads, which arm an AbortSignal timeout per indexer call), and about
    // 1,000 labels' work per request: a request of several seconds loses its local connection.
    const k = Math.min(reps, path === '/inspect' ? 500 : 50, Math.max(1, Math.floor(1000 / labelsOf(body))));
    for (let i = 0; i < 5; i++) batches.push((await post(`${path}?k=${k}`, body))[key]);
    result.inIsolateMsPerRun = round3(Math.min(...batches));
  }
  return { ...result, refused: first.refused ?? null, bytes: first.bytes };
}
try {
  // Warm-up: the first requests compile the Worker's code paths (and the first chain read builds the Ed25519 tables:
  // the cold reading is kept apart).
  report.chainReadsColdMs = (await (await worker.fetch('/chain')).json()).chainMs;
  for (let i = 0; i < 20; i++) {
    await post('/inspect', canonical(bundleOf(LABELS.ascii, 1000)));
    await post('/gate', canonical(bundleOf(LABELS.ascii, 10)));
  }
  // The fixed part of every upload: the local HTTP stack (an empty request) and the two chain reads.
  const chainReps = Math.max(MIN_REPS, Math.ceil(BUDGET / 2));
  report.emptyRequest = await measure('/noop', '', chainReps);
  report.chainReads = await measure('/chain', '', chainReps, 'chainMs');
  report.transactionRead = await measure('/transaction', '', chainReps, 'transactionMs');
  console.log('empty request', JSON.stringify(report.emptyRequest));
  console.log('chain reads', JSON.stringify(report.chainReads));
  console.log('one transaction read', JSON.stringify(report.transactionRead));
  for (const [name, label] of Object.entries(LABELS)) {
    report.constructions[name] = {};
    for (const n of SIZES) {
      const body = canonical(bundleOf(label, n));
      const reps = repetitions(n);
      const noop = await measure('/noop', body, reps);
      const inspect = await measure('/inspect', body, reps, 'inspectMs');
      if (inspect.refused !== null) throw new Error(`${name} n=${n} was refused (${inspect.refused})`);
      const steps = [];
      for (let i = 0; i < Math.min(reps, 20); i++) steps.push(await post('/steps', body));
      const entry = {
        bytes: inspect.bytes,
        repetitions: reps,
        noopProcessCpuMsPerRequest: noop.processCpuMsPerRequest,
        processCpuMsPerRequest: inspect.processCpuMsPerRequest,
        inIsolateMsPerRun: inspect.inIsolateMsPerRun,
        stepsMinMs: Object.fromEntries(
          ['sha256Ms', 'decodeMs', 'parseMs', 'canonicalMs', 'validateMs'].map((k) => [
            k,
            round3(Math.min(...steps.map((s) => s[k]))),
          ]),
        ),
      };
      report.constructions[name][n] = entry;
      console.log(name, n, JSON.stringify(entry));
    }
  }
  // Non-bundles as large as the CJK bundle of each n: the CPU the gate spends before refusing them.
  report.nonBundles = {};
  for (const [name, make] of Object.entries(NON_BUNDLES)) {
    report.nonBundles[name] = {};
    for (const n of SIZES) {
      const body = make(Buffer.byteLength(canonical(bundleOf(LABELS.cjk, n))));
      report.nonBundles[name][n] = await measure('/inspect', body, repetitions(n), 'inspectMs');
      console.log(name, n, JSON.stringify(report.nonBundles[name][n]));
    }
  }
  // The whole CPU-bound part of one upload (bundle inspection and both chain reads in one request) for the
  // constructions and sizes named by --gate (name:n,...), e.g. the worst construction at a hosting cap.
  if (args.gate) {
    report.gate = {};
    for (const item of args.gate.split(',')) {
      const [name, n] = item.split(':');
      const body = canonical(bundleOf(LABELS[name], Number(n)));
      report.gate[item] = await measure('/gate', body, Math.max(MIN_REPS, Math.ceil(BUDGET / 2)), 'gateMs');
      console.log('gate', item, JSON.stringify(report.gate[item]));
    }
  }
} finally {
  await worker.stop();
  // Written even when a measurement fails, so what was measured is kept (a failure is printed and exits non-zero).
  await writeFile(new URL(args.out, `file://${process.cwd()}/`), `${JSON.stringify(report, null, 2)}\n`);
  console.log('written', args.out);
}
