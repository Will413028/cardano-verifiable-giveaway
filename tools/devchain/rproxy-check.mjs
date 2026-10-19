// Plan step 9 (PD8 A): the committed reverse proxy config (deploy/dolos-proxy/nginx.conf) run in a real nginx in front
// of the real Dolos dev chain, nothing mocked. Usage, with Dolos on the dev chain after tools/devchain/acceptance.mjs
// and `make build` done:
//   GIVEAWAY_NGINX=<nginx 1.30 binary> node tools/devchain/rproxy-check.mjs <acceptance out dir> <run dir>
// <run dir> receives one nginx prefix (logs included) per variant. Prints the report (raw output, copied into
// docs/plans/2026-10-18-hardening-and-backend/rproxy-nginx-1.30.6-report.json) and exits 1 when an expectation fails.
//
// Variants: the committed file, then one guard removed at a time (allowlist, rate limit, CORS list, log format), each
// expected to fail exactly its own check; and `nodelay`, the same allowance without the delay queue, recorded for
// the design note only. Each variant runs in a fresh nginx process, so its rate-limit zone and logs start empty.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { BlockfrostChain, identityOf, verifyProof } from '@giveaway/verifier-cli/library';
import { BASE } from './devchain.mjs';

const [out, runDir] = process.argv.slice(2);
if (!out || !runDir || !process.env.GIVEAWAY_NGINX)
  throw new Error('Usage: GIVEAWAY_NGINX=<nginx> node tools/devchain/rproxy-check.mjs <acceptance out dir> <run dir>');
const root = fileURLToPath(new URL('../../', import.meta.url));
const CONFIG = await readFile(`${root}deploy/dolos-proxy/nginx.conf`, 'utf8');
// The committed file's local values (its DEPLOY lines): listen 127.0.0.1:3020, Dolos 127.0.0.1:3010, page origin.
const PROXY = { host: '127.0.0.1', port: 3020 };
const PROXY_URL = `http://${PROXY.host}:${PROXY.port}`;
const PAGE = 'http://127.0.0.1:4320';
const FOREIGN = 'https://other-site.example';
if (new URL(BASE).port !== '3010') throw new Error('The committed config proxies to Dolos on 127.0.0.1:3010');
const MARKER = 'leakmarker7q';
const proof = JSON.parse(await readFile(`${out}/proof.json`, 'utf8'));
const accepted = JSON.parse(await readFile(`${out}/report.json`, 'utf8'));
const txHash = proof.txHash;
const owner = proof.owner;
const stake = identityOf(owner).key;
const log = (...args) => console.error(new Date().toISOString(), ...args);

// One HTTP/1.1 request on its own connection; the path is sent exactly as given (no client-side normalization).
function raw(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request({ ...PROXY, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const listening = () =>
  new Promise((resolve) => {
    const socket = connect(PROXY.port, PROXY.host);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

// The verifier library through the proxy: every status it got, by request.
async function verifyThrough(base) {
  const statuses = [];
  const chain = new BlockfrostChain(base, async (input, init) => {
    const response = await fetch(input, init);
    statuses.push(response.status);
    return response;
  });
  const started = performance.now();
  const verdict = await verifyProof(proof, { chain });
  // Recorded, never asserted: localhost duration only.
  const ms = Math.round(performance.now() - started);
  const by = {};
  for (const s of statuses) by[s] = (by[s] ?? 0) + 1;
  return {
    status: verdict.status,
    checks: verdict.checks,
    conflicts: verdict.conflicts,
    requests: statuses.length,
    by,
    ms,
  };
}
const direct = await verifyThrough(BASE);
log('direct verification', direct.status, direct.requests);

const checks = {
  // A full verification (the acceptance identity: its withdrawal list after acceptance.mjs's overlapping commitment)
  // through the proxy, twice back to back: never a 429 or 5xx, and the same verdict as reading Dolos directly.
  async verification() {
    const runs = [await verifyThrough(PROXY_URL), await verifyThrough(PROXY_URL)];
    const same = runs.every(
      (r) =>
        r.status === direct.status &&
        JSON.stringify([r.checks, r.conflicts]) === JSON.stringify([direct.checks, direct.conflicts]),
    );
    const refused = runs.some((r) => Object.keys(r.by).some((s) => s === '429' || Number(s) >= 500));
    return {
      pass: same && !refused,
      detail: runs.map((r) => ({ status: r.status, requests: r.requests, statuses: r.by, ms: r.ms })),
    };
  },
  // BR-01: allowlisted reads reach Dolos; everything else is answered by the proxy (each refused path is one Dolos
  // answers 200 or 400 itself, so reaching it would show).
  async allowlist() {
    const allowed = [
      '/blocks/latest',
      `/txs/${txHash}`,
      `/txs/${txHash}/cbor`,
      `/txs/${txHash}/utxos`,
      `/txs/${txHash}/metadata`,
      '/epochs/latest/parameters',
      `/accounts/${stake}`,
      `/accounts/${stake}/withdrawals?order=asc&count=100&page=1`,
    ];
    const refused = [
      ['GET', '/', 404],
      ['GET', '/health', 404],
      ['GET', '/genesis', 404],
      ['GET', `/addresses/${owner}/utxos`, 404],
      // The PD9 enumeration, superseded by the withdrawal list (step 9b): Dolos answers both with 200.
      ['GET', `/accounts/${stake}/addresses?count=100&page=1`, 404],
      ['GET', `/addresses/${owner}/transactions?order=asc&count=100&page=1`, 404],
      ['GET', `/accounts/${stake}/withdrawals%0A`, 404],
      ['GET', `/txs/${txHash}/%2e%2e/%2e%2e/genesis`, 404],
      ['GET', `/blocks/latest/../../genesis`, 404],
      ['GET', `/blocks/latest%0A`, 404],
      ['GET', `/txs/${txHash}%0A`, 404],
      ['POST', '/tx/submit', 404],
      ['POST', '/blocks/latest', 405],
      ['GET', '/blocks/latest?select=hash', 400],
    ];
    const got = {};
    for (const path of allowed) got[`GET ${path}`] = (await raw('GET', path)).status;
    for (const [method, path] of refused)
      got[`${method} ${path}`] = (
        await raw(method, path, { 'Content-Type': 'application/cbor' }, method === 'POST' ? 'a0' : undefined)
      ).status;
    const pass =
      allowed.every((path) => got[`GET ${path}`] === 200) &&
      refused.every(([method, path, status]) => got[`${method} ${path}`] === status);
    return { pass, detail: got };
  },
  // BR-04: the listed origin is named (never *), a foreign origin is refused with no CORS header, and a request
  // without Origin passes without one.
  async cors() {
    const preflight = (origin) =>
      raw('OPTIONS', '/epochs/latest/parameters', {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'content-type',
      });
    const r = {
      page: await raw('GET', '/blocks/latest', { Origin: PAGE }),
      pagePreflight: await preflight(PAGE),
      foreign: await raw('GET', '/blocks/latest', { Origin: FOREIGN }),
      foreignPreflight: await preflight(FOREIGN),
      noOrigin: await raw('GET', '/blocks/latest'),
    };
    const acao = (x) => x.headers['access-control-allow-origin'] ?? null;
    const detail = Object.fromEntries(
      Object.entries(r).map(([k, x]) => [
        k,
        { status: x.status, allowOrigin: acao(x), allowHeaders: x.headers['access-control-allow-headers'] ?? null },
      ]),
    );
    const pass =
      r.page.status === 200 &&
      acao(r.page) === PAGE &&
      r.pagePreflight.status === 204 &&
      acao(r.pagePreflight) === PAGE &&
      /content-type/i.test(r.pagePreflight.headers['access-control-allow-headers'] ?? '') &&
      r.foreign.status === 403 &&
      acao(r.foreign) === null &&
      r.foreignPreflight.status === 403 &&
      acao(r.foreignPreflight) === null &&
      r.noOrigin.status === 200 &&
      acao(r.noOrigin) === null;
    return { pass, detail };
  },
  // BR-03: 450 concurrent requests from one address, more than the 350 the limit admits in excess; asserted on the
  // answers (some are 429), never on elapsed time. The page's origin is sent so the 429 must carry CORS.
  async flood() {
    const answers = await Promise.all(
      Array.from({ length: 450 }, () => raw('GET', '/blocks/latest', { Origin: PAGE })),
    );
    const by = {};
    for (const a of answers) by[a.status] = (by[a.status] ?? 0) + 1;
    const limited = answers.filter((a) => a.status === 429);
    return {
      pass: limited.length > 0 && limited.every((a) => a.headers['access-control-allow-origin'] === PAGE),
      detail: { statuses: by },
    };
  },
};

// BR-05, read after all traffic of a variant, including requests that carry a marker in an allowed query value, a
// header and a body: the logs hold neither the marker nor the client address, any transaction id, address or stake
// key, nor a query string; the access log is not empty, so it is written at all.
async function markerTraffic() {
  await raw('GET', `/accounts/${stake}/withdrawals?order=${MARKER}`, { 'X-Note': MARKER });
  await raw('POST', `/txs/${txHash}`, { 'Content-Type': 'text/plain' }, MARKER);
  await raw('GET', `/txs/${txHash}/cbor`, { Cookie: `session=${MARKER}`, Origin: PAGE });
}
async function logs(prefix) {
  const access = await readFile(`${prefix}/logs/access.log`, 'utf8').catch(() => '');
  const error = await readFile(`${prefix}/logs/error.log`, 'utf8').catch(() => '');
  const forbidden = [MARKER, '127.0.0.1', txHash, owner, 'addr_test1', 'stake_test1', 'addr_vkh1', '?', 'HTTP/1.1'];
  const found = forbidden.filter((f) => access.includes(f) || error.includes(f));
  const lines = access.split('\n').filter(Boolean);
  return {
    pass: found.length === 0 && lines.length > 0,
    detail: {
      found,
      accessLines: lines.length,
      errorBytes: error.length,
      sample: lines.slice(0, 3),
      statusCounts: count(lines),
    },
  };
}
const count = (lines) => {
  const by = {};
  for (const line of lines) {
    const status = line.split(' ')[3];
    by[status] = (by[status] ?? 0) + 1;
  }
  return by;
};

// Recorded proxy answers the browser check's indexer mock copies (tools/browser-check.mjs): what a page sees when it
// asks the proxy for something outside the allowlist.
async function captures() {
  const pick = (r) => ({
    status: r.status,
    headers: Object.fromEntries(
      Object.entries(r.headers).filter(([k]) => k.startsWith('access-control') || k === 'content-type' || k === 'vary'),
    ),
    body: r.body,
  });
  return {
    'tx-submit': pick(await raw('POST', '/tx/submit', { Origin: PAGE, 'Content-Type': 'application/cbor' }, 'a0')),
    'foreign-origin': pick(await raw('GET', '/blocks/latest', { Origin: FOREIGN })),
  };
}

function replaceOnce(text, from, to) {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`Mutation target not found exactly once: ${from}`);
  return text.slice(0, at) + to + text.slice(at + from.length);
}
const VARIANTS = [
  { name: 'committed', config: CONFIG, expectFail: [] },
  {
    name: 'no-allowlist',
    config: replaceOnce(CONFIG, 'map $uri $route {\n    default "";', 'map $uri $route {\n    default any;'),
    expectFail: ['allowlist'],
  },
  {
    name: 'no-rate-limit',
    config: replaceOnce(CONFIG, '      limit_req zone=dolos_ip burst=350 delay=300;\n', ''),
    expectFail: ['flood'],
  },
  {
    name: 'no-origin-list',
    config: replaceOnce(CONFIG, 'default refused;', 'default allowed;'),
    expectFail: ['cors'],
  },
  {
    name: 'request-in-log',
    config: replaceOnce(
      CONFIG,
      "log_format giveaway '$time_iso8601",
      'log_format giveaway \'$remote_addr "$request" $time_iso8601',
    ),
    expectFail: ['logs'],
  },
  {
    name: 'nodelay',
    config: replaceOnce(CONFIG, 'burst=350 delay=300', 'burst=300 nodelay'),
    expectFail: null,
  },
];

async function runVariant(variant) {
  const prefix = `${runDir}/${variant.name}`;
  await mkdir(`${prefix}/logs`, { recursive: true });
  await writeFile(`${prefix}/nginx.conf`, variant.config);
  if (await listening()) throw new Error(`${PROXY_URL} is already taken`);
  const nginx = spawn(process.env.GIVEAWAY_NGINX, ['-p', prefix, '-c', `${prefix}/nginx.conf`, '-g', 'daemon off;'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const exited = new Promise((resolve) => nginx.once('exit', resolve));
  try {
    for (let i = 0; !(await listening()); i++) {
      if (i > 100) throw new Error('nginx did not start');
      await new Promise((r) => setTimeout(r, 50));
    }
    log(variant.name, 'nginx pid', nginx.pid);
    const result = { pid: nginx.pid, checks: {} };
    // Verification first, while the client's allowance is untouched by the other checks; the flood last.
    for (const name of ['verification', 'allowlist', 'cors']) result.checks[name] = await checks[name]();
    await markerTraffic();
    result.checks.flood = await checks.flood();
    if (variant.name === 'committed') result.captures = await captures();
    // Graceful stop flushes the access log; the logs are read after the process is gone.
    nginx.kill('SIGQUIT');
    await exited;
    result.checks.logs = await logs(prefix);
    const failed = Object.entries(result.checks)
      .filter(([, c]) => !c.pass)
      .map(([n]) => n);
    result.failed = failed;
    result.asExpected =
      variant.expectFail === null ? null : JSON.stringify(failed) === JSON.stringify(variant.expectFail);
    return result;
  } finally {
    if (nginx.exitCode === null && nginx.signalCode === null) {
      nginx.kill('SIGQUIT');
      await exited;
    }
  }
}

const nginxVersion = await new Promise((resolve) => {
  const v = spawn(process.env.GIVEAWAY_NGINX, ['-v'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let text = '';
  v.stderr.on('data', (c) => {
    text += c;
  });
  v.on('exit', () => resolve(text.trim()));
});
const report = {
  nginx: nginxVersion,
  dolos: BASE,
  proxy: PROXY_URL,
  identityRows: accepted.enumeration.rows,
  direct: { status: direct.status, requests: direct.requests, statuses: direct.by, ms: direct.ms },
  variants: {},
};
for (const variant of VARIANTS) {
  log('variant', variant.name);
  report.variants[variant.name] = await runVariant(variant);
}
console.log(JSON.stringify(report, null, 2));
const bad = Object.entries(report.variants).filter(([, v]) => v.asExpected === false);
if (bad.length) {
  console.error('Unexpected results:', bad.map(([n, v]) => `${n}: failed ${JSON.stringify(v.failed)}`).join('; '));
  process.exit(1);
}
