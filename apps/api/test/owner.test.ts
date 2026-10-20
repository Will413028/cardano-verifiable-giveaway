import { BlockfrostChain, decodeBech32 } from '@giveaway/chain';
import { sha256 } from '@giveaway/protocol';
import { createScheduledController, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { NONCE_SWEEP_MARGIN } from '../src/auth.ts';
import { objectKey } from '../src/bundles.ts';
import { extend as extendHosting } from '../src/owner.ts';
import worker, { clientKey, type Env, handle } from '../src/index.ts';
import { addMonths, HOSTING_MONTHS } from '../src/retention.ts';
import fixture from './chain-fixture.json';
import { authorization, issuedNonce, rewardAddress, SEEDS, secretOf, type Who } from './sign.ts';

// Signed owner operations (plan step 11; BR-09, BR-13, BR-17; B3) against real local D1, R2 and the Rate Limiting
// binding (Miniflare), the real BlockfrostChain replaying chain-fixture.json, and signatures made with the fixture's
// test keys (test/sign.ts).
type Answer = { status: number; headers: Record<string, string>; body: string };
const answers = fixture.answers as Record<string, Answer>;
const chain = () =>
  new BlockfrostChain(fixture.indexer, async (url) => {
    const answer = answers[url.slice(fixture.indexer.length)];
    if (!answer) throw new Error(`chain-fixture.json has no answer for ${url}`);
    return new Response(answer.body === '' ? null : answer.body, { status: answer.status, headers: answer.headers });
  });
const PAGE = 'http://127.0.0.1:4320';
const bindings = env as unknown as Env;
const T = fixture.roundTime;
const { txs, bundles } = fixture;
const VALID_HASH = await sha256(bundles.valid);
// The fixture's round is three years after this time, so the retention base is the first hosting itself.
const EARLY = addMonths(T, -36);

let client = 0;
const request = (
  method: string,
  path: string,
  at: number,
  { auth, body, ip }: { auth?: string; body?: BodyInit; ip?: string } = {},
) =>
  handle(
    new Request(`http://api.test${path}`, {
      method,
      body,
      headers: {
        Origin: PAGE,
        'CF-Connecting-IP': ip ?? `192.0.2.${++client % 250}`,
        ...(auth ? { Authorization: auth } : {}),
      },
    }),
    bindings,
    { now: () => at, chain },
  );
const sign = (
  operation: 'host' | 'delete' | 'extend',
  at: number,
  extra: Parameters<typeof authorization>[1] | object = {},
  who: Who = 'organizer',
) => authorization(who, { operation, txHash: txs.organizer, bundleHash: VALID_HASH, at, ...extra });
type Auth = string | Promise<string>;
const host = async (at: number, auth: Auth = sign('host', at)) =>
  request('PUT', `/bundles/${txs.organizer}`, at, { auth: await auth, body: bundles.valid });
const remove = async (at: number, auth: Auth = sign('delete', at)) =>
  request('DELETE', `/bundles/${txs.organizer}`, at, { auth: await auth });
const extend = async (at: number, auth: Auth = sign('extend', at)) =>
  request('POST', `/bundles/${txs.organizer}/extend`, at, { auth: await auth });
const answer = async (response: Response) => [response.status, await response.text()];
const json = async <T>(response: Response, status = 200) => {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
};
const expiry = async () =>
  (
    await bindings.DB.prepare('SELECT expires_at FROM hosted WHERE tx_hash = ?')
      .bind(txs.organizer)
      .first<{ expires_at: number }>()
  )?.expires_at;
const firstHosting = () =>
  bindings.DB.prepare('SELECT first_hosted_at, extensions FROM first_hosting WHERE tx_hash = ?')
    .bind(txs.organizer)
    .first<{ first_hosted_at: number; extensions: number }>();

beforeEach(async () => {
  await bindings.DB.batch(
    ['hosted', 'tombstones', 'collecting', 'first_hosting', 'used_nonces'].map((table) =>
      bindings.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
  await bindings.DB.prepare('UPDATE nonce_sweep SET swept_through = 0').run();
  const listed = await bindings.BUNDLES.list();
  if (listed.objects.length) await bindings.BUNDLES.delete(listed.objects.map((o) => o.key));
});

describe('nonce endpoint (BR-09, B3)', () => {
  it('issues a fresh MACed nonce carrying the backend clock, with a 5-minute window, and stores nothing', async () => {
    const one = await json<{ nonce: string; issuedAt: number; expiresAt: number }>(await request('GET', '/nonce', T));
    const two = await json<{ nonce: string }>(await request('GET', '/nonce', T));
    expect(one).toEqual({ nonce: expect.stringMatching(/^[a-f0-9]{108}$/), issuedAt: T, expiresAt: T + 300 });
    expect(Number.parseInt(one.nonce.slice(32, 44), 16)).toBe(T);
    expect(two.nonce).not.toBe(one.nonce);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM used_nonces').first('n')).toBe(0);
  });

  it('refuses a NONCE_KEY shorter than 32 characters', async () => {
    const short = { ...bindings, NONCE_KEY: 'x'.repeat(31) } as Env;
    const response = await handle(new Request('http://api.test/nonce', { headers: { Origin: PAGE } }), short, {
      now: () => T,
      chain,
    });
    expect(await answer(response)).toEqual([503, 'Owner operations are not configured (no NONCE_KEY)']);
  });

  it('refuses to issue nonces or authorize owner operations without NONCE_KEY', async () => {
    const unset = { ...bindings, NONCE_KEY: undefined } as Env;
    const at = (path: string, init: RequestInit = {}) =>
      handle(new Request(`http://api.test${path}`, { ...init, headers: { Origin: PAGE, ...init.headers } }), unset, {
        now: () => T,
        chain,
      });
    expect((await at('/nonce')).status).toBe(503);
    const auth = await sign('delete', T);
    expect(
      await answer(await at(`/bundles/${txs.organizer}`, { method: 'DELETE', headers: { Authorization: auth } })),
    ).toEqual([503, 'Owner operations are not configured (no NONCE_KEY)']);
  });
});

describe('signed owner operations (BR-09, BR-13, BR-17)', () => {
  it('the owner deletes the hosting: the record and its bytes go, the first hosting time stays', async () => {
    expect((await host(EARLY)).status).toBe(201);
    expect(await json(await remove(EARLY + 60))).toEqual({ txHash: txs.organizer, deleted: true });
    expect((await request('GET', `/bundles/${txs.organizer}`, EARLY + 61)).status).toBe(404);
    expect(await bindings.BUNDLES.head(objectKey(VALID_HASH))).toBeNull();
    expect(await firstHosting()).toEqual({ first_hosted_at: EARLY, extensions: 0 });
  });

  it('the owner extends 12 months at a time up to 36 months after the base time; an extension past the cap is refused', async () => {
    expect((await host(EARLY)).status).toBe(201);
    expect(await expiry()).toBe(addMonths(EARLY, HOSTING_MONTHS));
    expect(await json(await extend(EARLY + 60))).toEqual({
      txHash: txs.organizer,
      expiresAt: addMonths(EARLY, 24),
      extensionsLeft: 1,
    });
    expect(await json(await extend(EARLY + 120))).toEqual({
      txHash: txs.organizer,
      expiresAt: addMonths(EARLY, 36),
      extensionsLeft: 0,
    });
    const past = await extend(EARLY + 180);
    expect(past.status).toBe(409);
    expect(await past.text()).toMatch(/^Hosting is already extended to its limit: 36 months/);
    expect(await expiry()).toBe(addMonths(EARLY, 36));
    expect(await firstHosting()).toEqual({ first_hosted_at: EARLY, extensions: 2 });
    expect((await request('GET', `/bundles/${txs.organizer}`, addMonths(EARLY, 36) - 1)).status).toBe(200);
    expect((await request('GET', `/bundles/${txs.organizer}`, addMonths(EARLY, 36))).status).toBe(410);
  });

  it('extensions are counted from the base time and kept across a deletion and a new hosting', async () => {
    // A round before the hosting: the base is the round time.
    const at = addMonths(T, 2);
    expect(await json<{ expiresAt: number }>(await host(at), 201)).toMatchObject({ expiresAt: addMonths(T, 12) });
    expect(await json(await extend(at + 1))).toMatchObject({ expiresAt: addMonths(T, 24) });
    expect((await remove(at + 2)).status).toBe(200);
    expect(await json<{ expiresAt: number }>(await host(at + 3), 201)).toMatchObject({ expiresAt: addMonths(T, 24) });
  });

  it('an ended hosting is not extended', async () => {
    expect((await host(EARLY)).status).toBe(201);
    const ended = addMonths(EARLY, HOSTING_MONTHS);
    expect(await answer(await extend(ended))).toEqual([410, 'The hosting period of this bundle has ended']);
  });

  it('refuses an expired message, and one issued in the future', async () => {
    expect((await host(EARLY)).status).toBe(201);
    const at = EARLY + 1000;
    // The window is [issued, issued + 300 s).
    expect(await answer(await extend(at, sign('extend', at, { issuedAt: at - 300 })))).toEqual([
      401,
      'The signed message has expired (5 minutes); sign again',
    ]);
    expect(await answer(await remove(at, sign('delete', at, { issuedAt: at - 300 })))).toEqual([
      401,
      'The signed message has expired (5 minutes); sign again',
    ]);
    expect(await answer(await extend(at, sign('extend', at, { issuedAt: at + 1 })))).toEqual([
      401,
      'The signed message was issued in the future',
    ]);
    expect(await expiry()).toBe(addMonths(EARLY, HOSTING_MONTHS));
    expect((await extend(at, sign('extend', at, { issuedAt: at - 299 }))).status).toBe(200);
  });

  it('refuses a reused nonce: a signed message authorizes one operation', async () => {
    expect((await host(EARLY)).status).toBe(201);
    const once = await sign('extend', EARLY);
    expect((await extend(EARLY + 10, once)).status).toBe(200);
    expect(await answer(await extend(EARLY + 20, once))).toEqual([
      409,
      'This signed message was already used (one-time nonce); sign the operation again',
    ]);
    expect(await expiry()).toBe(addMonths(EARLY, 24));
    // A deletion replayed after the owner hosted again would delete the new hosting.
    const deletion = await sign('delete', EARLY + 30);
    expect((await remove(EARLY + 40, deletion)).status).toBe(200);
    expect((await host(EARLY + 50)).status).toBe(201);
    expect((await remove(EARLY + 60, deletion)).status).toBe(409);
    expect((await request('GET', `/bundles/${txs.organizer}`, EARLY + 70)).status).toBe(200);
    // And the hosting itself: the same signed upload twice.
    const upload = await sign('host', EARLY + 80);
    expect((await host(EARLY + 90, upload)).status).toBe(200);
    expect((await host(EARLY + 100, upload)).status).toBe(409);
  });

  it('refuses a nonce the backend did not issue, a forged one, and a message post-dated past its nonce', async () => {
    expect((await host(EARLY)).status).toBe(201);
    const refused = [401, 'The nonce of the signed message was not issued by this backend at its issue time'];
    expect(await answer(await extend(EARLY, sign('extend', EARLY, { nonce: '7'.repeat(32) })))).toEqual(refused);
    // Signed with a nonce issued at EARLY, but naming a later issue time: inside its own claimed window at EARLY + 200,
    // it would otherwise still be usable long after the nonce was handed out.
    const nonce = await issuedNonce(EARLY);
    expect(
      await answer(await extend(EARLY + 200, sign('extend', EARLY + 200, { nonce, issuedAt: EARLY + 100 }))),
    ).toEqual(refused);
    // The same nonce with its time field rewritten to match the post-dated message: only the MAC refuses it.
    const later = (EARLY + 100).toString(16).padStart(12, '0');
    const forged = nonce.slice(0, 32) + later + nonce.slice(44);
    expect(
      await answer(await extend(EARLY + 200, sign('extend', EARLY + 200, { nonce: forged, issuedAt: EARLY + 100 }))),
    ).toEqual(refused);
    expect(await expiry()).toBe(addMonths(EARLY, HOSTING_MONTHS));
    expect((await extend(EARLY + 200, sign('extend', EARLY + 200, { nonce, issuedAt: EARLY }))).status).toBe(200);
  });

  it('refuses owner operations when no page origin is configured (no domain to sign for)', async () => {
    expect((await host(EARLY)).status).toBe(201);
    // Without ALLOWED_ORIGIN every browser is refused by CORS; a request without Origin reaches the route and must
    // still be refused, whatever domain the message names.
    const response = await handle(
      new Request(`http://api.test/bundles/${txs.organizer}`, {
        method: 'DELETE',
        headers: { Authorization: await sign('delete', EARLY), 'CF-Connecting-IP': '192.0.2.251' },
      }),
      { ...bindings, ALLOWED_ORIGIN: undefined },
      { now: () => EARLY, chain },
    );
    expect(await answer(response)).toEqual([401, 'The signed message was written for another site']);
    expect((await request('GET', `/bundles/${txs.organizer}`, EARLY)).status).toBe(200);
  });

  it('of two extensions computed from the same state, one counts and the other is refused (review L3)', async () => {
    expect((await host(EARLY)).status).toBe(201);
    // The outer request reads extensions = 0, then the inner one runs to completion before the outer one writes.
    let inner: Response | undefined;
    const real = bindings.DB;
    const DB = {
      prepare: (query: string) => real.prepare(query),
      batch: async (statements: D1PreparedStatement[]) => {
        inner ??= await extend(EARLY + 2);
        return real.batch(statements);
      },
    } as unknown as D1Database;
    const outer = new Request(`http://api.test/bundles/${txs.organizer}/extend`, {
      method: 'POST',
      headers: { Authorization: await sign('extend', EARLY + 1) },
    });
    await expect(extendHosting({ ...bindings, DB }, outer, txs.organizer, EARLY + 1, '127.0.0.1:4320')).rejects.toThrow(
      'The hosting was extended by a concurrent request; retry',
    );
    expect(inner?.status).toBe(200);
    expect(await firstHosting()).toEqual({ first_hosted_at: EARLY, extensions: 1 });
    expect(await expiry()).toBe(addMonths(EARLY, 24));
  });

  it('refuses a message signed for another site', async () => {
    expect((await host(EARLY)).status).toBe(201);
    for (const domain of ['evil.example', '127.0.0.1:4321'])
      expect(await answer(await extend(EARLY, sign('extend', EARLY, { domain })))).toEqual([
        401,
        'The signed message was written for another site',
      ]);
    expect(await answer(await host(EARLY, sign('host', EARLY, { domain: 'evil.example' })))).toEqual([
      401,
      'The signed message was written for another site',
    ]);
  });

  it('refuses a message signed for another network', async () => {
    expect((await host(EARLY)).status).toBe(201);
    expect(await answer(await remove(EARLY, sign('delete', EARLY, { network: 'mainnet' })))).toEqual([
      401,
      'The signed message is for another network than preprod',
    ]);
    expect((await request('GET', `/bundles/${txs.organizer}`, EARLY)).status).toBe(200);
  });

  it("refuses any key but the commitment's organizer stake key", async () => {
    expect((await host(EARLY)).status).toBe(201);
    const refused = [
      403,
      "The signing key is not this commitment's organizer stake key (sign with its reward address)",
    ];
    // Another organizer's stake key, signing for its own reward address: a valid signature by someone else.
    expect(await answer(await remove(EARLY, sign('delete', EARLY, {}, 'other')))).toEqual(refused);
    expect(await answer(await extend(EARLY, sign('extend', EARLY, {}, 'other')))).toEqual(refused);
    // The organizer's payment key (seed 1) for its base address: the address is the owner's, the key is not its
    // identity key (PD3).
    const paymentBase = Uint8Array.from([0x00, ...paymentKeyHash(), ...rewardAddress('organizer').subarray(1)]);
    expect(
      await answer(await remove(EARLY, sign('delete', EARLY, { secret: secretOf(1), address: paymentBase }))),
    ).toEqual(refused);
    // Another key naming the organizer's reward address: the signature cannot verify for that address.
    expect(
      await answer(
        await remove(
          EARLY,
          sign('delete', EARLY, { secret: secretOf(SEEDS.other), address: rewardAddress('organizer') }),
        ),
      ),
    ).toEqual([401, 'The signature does not verify']);
    expect((await request('GET', `/bundles/${txs.organizer}`, EARLY)).status).toBe(200);
    expect(await expiry()).toBe(addMonths(EARLY, HOSTING_MONTHS));
  });

  it('refuses a message for another operation, commitment or bundle, and requests without a valid signature', async () => {
    expect((await host(EARLY)).status).toBe(201);
    expect(await answer(await extend(EARLY, sign('delete', EARLY)))).toEqual([
      401,
      'The signed message authorizes "delete", not "extend"',
    ]);
    expect(await answer(await extend(EARLY, sign('extend', EARLY, { txHash: txs.other })))).toEqual([
      401,
      'The signed message names another commitment',
    ]);
    expect(await answer(await extend(EARLY, sign('extend', EARLY, { bundleHash: 'ab'.repeat(32) })))).toEqual([
      409,
      'The signed message names another bundle than the one hosted for this commitment',
    ]);
    expect((await request('DELETE', `/bundles/${txs.organizer}`, EARLY)).status).toBe(401);
    expect(await answer(await remove(EARLY, 'Bearer token'))).toEqual([
      401,
      'Malformed Authorization header (expected CIP30 <COSE_Sign1 hex> <COSE_Key hex>)',
    ]);
    // The signed text must be exactly the rendered owner operation.
    const loose = await sign('delete', EARLY, { text: 'delete please' });
    expect(await answer(await remove(EARLY, loose))).toEqual([401, 'The signed message is not an owner operation']);
    expect((await request('GET', `/bundles/${txs.organizer}`, EARLY)).status).toBe(200);
  });

  it('the Cron run deletes every nonce use record past its window, however many there are', async () => {
    expect((await host(EARLY)).status).toBe(201);
    const count = () => bindings.DB.prepare('SELECT COUNT(*) AS n FROM used_nonces').first('n');
    expect(await count()).toBe(1);
    // More rows than one sweep of hosting records (500) removes: the nonce sweep has no per-run bound.
    await bindings.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
       INSERT INTO used_nonces (nonce, expires_at) SELECT printf('%0108x', i), ? FROM n`,
    )
      .bind(EARLY + 300)
      .run();
    expect(await count()).toBe(1501);
    // Kept NONCE_SWEEP_MARGIN past the window, then all deleted in one run.
    await worker.scheduled(
      createScheduledController({ scheduledTime: (EARLY + 300 + NONCE_SWEEP_MARGIN - 1) * 1000 }),
      bindings,
    );
    expect(await count()).toBe(1501);
    await worker.scheduled(
      createScheduledController({ scheduledTime: (EARLY + 300 + NONCE_SWEEP_MARGIN) * 1000 }),
      bindings,
    );
    expect(await count()).toBe(0);
  });

  // Review round 3 (MED, reproduced in Miniflare): the window is checked when the request starts and the use is
  // recorded later, so a replay verified just inside the window could be recorded after the sweep removed the first use.
  const sweepPast = (issued: number) =>
    worker.scheduled(
      createScheduledController({ scheduledTime: (issued + 300 + NONCE_SWEEP_MARGIN) * 1000 }),
      bindings,
    );

  it('a replayed extension verified inside its window but recorded after the sweep is refused', async () => {
    expect((await host(EARLY)).status).toBe(201);
    const once = await sign('extend', EARLY);
    expect((await extend(EARLY + 10, once)).status).toBe(200);
    await sweepPast(EARLY);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM used_nonces').first('n')).toBe(0);
    // The request's clock still reads inside the window: only the sweep watermark refuses it.
    expect(await answer(await extend(EARLY + 299, once))).toEqual([
      409,
      'This signed message was already used (one-time nonce); sign the operation again',
    ]);
    expect(await firstHosting()).toEqual({ first_hosted_at: EARLY, extensions: 1 });
  });

  it('an earlier sweep after a later one does not lower the watermark, so a replay stays refused', async () => {
    expect((await host(EARLY)).status).toBe(201);
    const once = await sign('extend', EARLY);
    expect((await extend(EARLY + 10, once)).status).toBe(200);
    const watermark = () =>
      bindings.DB.prepare('SELECT swept_through FROM nonce_sweep WHERE id = 1').first('swept_through');
    await sweepPast(EARLY);
    expect(await watermark()).toBe(EARLY + 300);
    // A delayed or manual Cron run with an earlier scheduled time.
    await worker.scheduled(createScheduledController({ scheduledTime: EARLY * 1000 }), bindings);
    expect(await watermark()).toBe(EARLY + 300);
    expect((await extend(EARLY + 299, once)).status).toBe(409);
    expect(await firstHosting()).toEqual({ first_hosted_at: EARLY, extensions: 1 });
  });

  it('a replayed upload whose body stalls across the sweep does not re-create a hosting the owner deleted', async () => {
    const upload = await sign('host', EARLY);
    expect((await host(EARLY + 5, upload)).status).toBe(201);
    expect((await remove(EARLY + 20)).status).toBe(200);
    expect((await host(EARLY + 30, upload)).status).toBe(409);
    let resume!: () => void;
    const gate = new Promise<void>((done) => {
      resume = done;
    });
    const bytes = new TextEncoder().encode(bundles.valid);
    const body = new ReadableStream({
      async pull(controller) {
        await gate;
        controller.enqueue(bytes);
        controller.close();
      },
    });
    // Verified at EARLY + 299, inside the window; the body arrives only after the Cron sweep.
    const pending = request('PUT', `/bundles/${txs.organizer}`, EARLY + 299, { auth: upload, body });
    await new Promise((done) => setTimeout(done, 50));
    // Past the window of every message so far (the deletion's too).
    await sweepPast(EARLY + 20);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM used_nonces').first('n')).toBe(0);
    resume();
    expect((await pending).status).toBe(409);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM hosted').first('n')).toBe(0);
  });
});

describe('the first hosting time is the owner’s (ADR Amendment 5, plan step 11)', () => {
  it('a third party cannot host, so cannot start the clock: the owner’s later hosting counts from its own time', async () => {
    // The bytes are public before the round; another organizer signs a hosting of this commitment with its own key.
    const third = await host(EARLY, sign('host', EARLY, {}, 'other'));
    expect(third.status).toBe(403);
    expect(await request('GET', `/bundles/${txs.organizer}`, EARLY).then((r) => r.status)).toBe(404);
    expect(await firstHosting()).toBeNull();
    // Unsigned, as anyone could before step 11.
    expect((await request('PUT', `/bundles/${txs.organizer}`, EARLY, { body: bundles.valid })).status).toBe(401);
    expect(await firstHosting()).toBeNull();
    // Six months later the organizer hosts: 12 months from then, as if nobody had tried.
    const own = addMonths(EARLY, 6);
    expect(await json<{ expiresAt: number }>(await host(own), 201)).toMatchObject({
      expiresAt: addMonths(own, HOSTING_MONTHS),
    });
    expect(await firstHosting()).toEqual({ first_hosted_at: own, extensions: 0 });
  });

  it('a live hosting is not rewritten by another key either (review L1)', async () => {
    expect((await host(EARLY)).status).toBe(201);
    expect(await answer(await host(EARLY + 1, sign('host', EARLY + 1, {}, 'other')))).toEqual([
      403,
      "The signing key is not this commitment's organizer stake key (sign with its reward address)",
    ]);
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM used_nonces').first('n')).toBe(1);
  });

  it('the signed bundle hash must be the hash of the uploaded bytes (review L2)', async () => {
    expect(await answer(await host(EARLY, sign('host', EARLY, { bundleHash: 'ab'.repeat(32) })))).toEqual([
      409,
      'The signed message names another bundle than the uploaded bytes',
    ]);
    expect(await firstHosting()).toBeNull();
  });
});

describe('per-address rate limit of the write routes', () => {
  it('refuses writes past 20 a minute from one address with 429, and only from that address and only writes', {
    timeout: 20000,
  }, async () => {
    // The local limiter counts per wall-clock minute: start away from a minute boundary so all requests share one.
    const second = (Date.now() / 1000) % 60;
    if (second > 50) await new Promise((resolve) => setTimeout(resolve, (61 - second) * 1000));
    const ip = '203.0.113.9';
    const write = () => request('PUT', `/bundles/${txs.organizer}`, T, { ip, body: bundles.valid });
    // Unsigned uploads: refused cheaply (401), each still counted.
    for (let i = 0; i < 20; i++) expect((await write()).status).toBe(401);
    const limited = await write();
    expect([limited.status, limited.headers.get('Retry-After')]).toEqual([429, '60']);
    expect((await request('DELETE', `/bundles/${txs.organizer}`, T, { ip })).status).toBe(429);
    expect((await request('POST', `/bundles/${txs.organizer}/extend`, T, { ip })).status).toBe(429);
    // Reads and the nonce (it writes nothing) are not limited; another address is not affected.
    expect((await request('GET', '/nonce', T, { ip })).status).toBe(200);
    expect((await request('GET', `/bundles/${txs.organizer}`, T, { ip })).status).toBe(404);
    expect(
      (await request('PUT', `/bundles/${txs.organizer}`, T, { ip: '203.0.113.10', body: bundles.valid })).status,
    ).toBe(401);
  });
});

describe('rate limit key: IPv4 address or IPv6 /64 (review M1)', () => {
  it('normalizes the client address (review round 3)', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey('::FFFF:1.2.3.4')).toBe('1.2.3.4');
    expect(clientKey('2001:DB8:A:b::1')).toBe('2001:0db8:000a:000b::/64');
    expect(clientKey('2001:db8:a:b:ffff:1:2:3')).toBe('2001:0db8:000a:000b::/64');
    for (const bad of [null, '', 'not an address', '203.0.113.7, 198.51.100.1', `${'a'.repeat(60)}`])
      expect([bad, clientKey(bad)]).toEqual([bad, 'unknown']);
  });

  it('counts every address of one IPv6 /64 together, and another /64 apart', { timeout: 20000 }, async () => {
    const second = (Date.now() / 1000) % 60;
    if (second > 50) await new Promise((resolve) => setTimeout(resolve, (61 - second) * 1000));
    const write = (ip: string) => request('PUT', `/bundles/${txs.organizer}`, T, { ip, body: bundles.valid });
    for (let i = 0; i < 20; i++) expect((await write(`2001:db8:a:b::${(i + 1).toString(16)}`)).status).toBe(401);
    expect((await write('2001:0db8:000a:000b:ffff:1:2:3')).status).toBe(429);
    expect((await write('2001:db8:a:c::1')).status).toBe(401);
  });
});

// The organizer's payment key hash, from its base address spent by the commitment (tools/api-fixture.mjs).
function paymentKeyHash(): number[] {
  const utxos = JSON.parse(answers[`/txs/${txs.organizer}/utxos`].body) as { inputs: { address: string }[] };
  return [...decodeBech32(utxos.inputs[0].address).bytes.subarray(1, 29)];
}
