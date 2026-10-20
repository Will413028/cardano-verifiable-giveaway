import { BlockfrostChain } from '@giveaway/chain';
import { BUNDLE_BYTE_LIMIT, sha256, validateBundle } from '@giveaway/protocol';
import { createScheduledController, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLAIM_STALE, objectKey, OWNER_QUOTA, RECONCILE_LIMIT, release, takedown } from '../src/bundles.ts';
import worker, { type Env, handle } from '../src/index.ts';
import { addMonths, HOSTING_MONTHS } from '../src/retention.ts';
import fixture from './chain-fixture.json';

// The upload gate against the real BlockfrostChain and real local D1 and R2 (Miniflare). The indexer answers are
// replayed from chain-fixture.json (tools/api-fixture.mjs: transactions signed with the test keys, answers from the
// Dolos-recorded mock); a request the fixture lacks fails the test instead of being invented here.
type Answer = { status: number; headers: Record<string, string>; body: string };
const answers = fixture.answers as Record<string, Answer>;
let requests: string[] = [];
const chain = () =>
  new BlockfrostChain(fixture.indexer, async (url) => {
    const path = url.slice(fixture.indexer.length);
    requests.push(path);
    const answer = answers[path];
    if (!answer) throw new Error(`chain-fixture.json has no answer for ${path}`);
    return new Response(answer.body === '' ? null : answer.body, { status: answer.status, headers: answer.headers });
  });
const PAGE = 'http://127.0.0.1:4320';
const bindings = env as unknown as Env;
const T = fixture.roundTime;
const { txs, bundles, owners } = fixture;
const call = (method: string, txHash: string, at: number, body?: BodyInit, on: Env = bindings) =>
  handle(new Request(`http://api.test/bundles/${txHash}`, { method, body, headers: { Origin: PAGE } }), on, {
    now: () => at,
    chain,
  });
const put = (txHash: string, body: BodyInit, at = T, on: Env = bindings) => call('PUT', txHash, at, body, on);
const get = (txHash: string, at = T) => call('GET', txHash, at);
const stored = async (bundleHash: string) => (await bindings.BUNDLES.head(objectKey(bundleHash))) !== null;
const records = async () =>
  (await bindings.DB.prepare('SELECT tx_hash FROM hosted ORDER BY tx_hash').all<{ tx_hash: string }>()).results.map(
    (r) => r.tx_hash,
  );
const VALID_HASH = await sha256(bundles.valid);
const QUOTA_HASH = await sha256(bundles.quota);
const cron = async (at: number) => {
  await worker.scheduled(createScheduledController({ scheduledTime: at * 1000, cron: '17 * * * *' }), bindings);
};
// The real bindings, with `hook` run once just before the first R2 `put` or `delete` (and that call failing when
// `fail` is set): an interleaving injected between two steps of one request. Only the order is controlled; every read
// and write still goes to Miniflare's D1 and R2.
function interleave(op: 'put' | 'delete', hook: () => Promise<unknown>, fail = false): Env {
  const real = bindings.BUNDLES;
  let fired = false;
  const step =
    <A extends unknown[], R>(name: 'put' | 'delete', call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (name === op && !fired) {
        fired = true;
        await hook();
        if (fail) throw new Error('injected R2 failure');
      }
      return call(...args);
    };
  const BUNDLES = {
    put: step('put', (...args: Parameters<R2Bucket['put']>) => real.put(...args)),
    delete: step('delete', (keys: string | string[]) => real.delete(keys)),
    get: (key: string) => real.get(key),
    head: (key: string) => real.head(key),
    list: (options?: R2ListOptions) => real.list(options),
  } as unknown as R2Bucket;
  return { ...bindings, BUNDLES };
}

beforeEach(async () => {
  requests = [];
  await bindings.DB.batch([
    bindings.DB.prepare('DELETE FROM hosted'),
    bindings.DB.prepare('DELETE FROM tombstones'),
    bindings.DB.prepare('DELETE FROM collecting'),
    bindings.DB.prepare('DELETE FROM first_hosting'),
    bindings.DB.prepare("UPDATE reconcile_cursor SET after = ''"),
  ]);
  const listed = await bindings.BUNDLES.list();
  if (listed.objects.length) await bindings.BUNDLES.delete(listed.objects.map((o) => o.key));
});

describe('upload gate (BR-06)', () => {
  it('hosts the bytes of a confirmed on-chain commitment for its organizer and serves them back', async () => {
    const response = await put(txs.organizer, bundles.valid);
    expect(response.status).toBe(201);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PAGE);
    const hosted = await response.json();
    expect(hosted).toEqual({
      txHash: txs.organizer,
      bundleHash: VALID_HASH,
      owner: owners.organizer,
      expiresAt: addMonths(T, HOSTING_MONTHS),
    });
    // The gate made the verifier's reads: owner from the transaction, then the commitment with its 15th block.
    expect(requests).toContain(`/txs/${txs.organizer}/cbor`);
    expect(requests).toContain(`/txs/${txs.organizer}/utxos`);
    expect(requests).toContain('/blocks/latest');
    const served = await get(txs.organizer);
    expect(served.status).toBe(200);
    expect(served.headers.get('X-Bundle-Hash')).toBe(VALID_HASH);
    expect(await served.text()).toBe(bundles.valid);
    // The same upload again is accepted without another chain read.
    requests = [];
    expect((await put(txs.organizer, bundles.valid)).status).toBe(200);
    expect(requests).toEqual([]);
  });

  it('refuses bytes whose hash is not the one the transaction committed', async () => {
    const response = await put(txs.invalid, bundles.valid);
    expect([response.status, await response.text()]).toEqual([
      409,
      'The bundle hash does not match the commitment of this transaction',
    ]);
    expect(await records()).toEqual([]);
  });

  it('refuses bytes that fail validateBundle even though their hash is committed on chain', async () => {
    // The transaction commits exactly these bytes (duplicate labels): only validateBundle stands between them and
    // hosting, so paying one fee cannot park an arbitrary file (ADR Rationale).
    const response = await put(txs.invalid, bundles.invalid);
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/^Not a valid bundle: Duplicate participant labels/);
    expect(await records()).toEqual([]);
    expect(await stored(await sha256(bundles.invalid))).toBe(false);
  });

  it('refuses a body over the protocol byte limit, declared or streamed, before any chain read', async () => {
    const over = new Uint8Array(BUNDLE_BYTE_LIMIT + 1).fill(0x20);
    const declared = await put(txs.organizer, over);
    expect([declared.status, await declared.text()]).toEqual([413, `Bundle exceeds ${BUNDLE_BYTE_LIMIT} bytes`]);
    // No Content-Length: the stream is cut as soon as it passes the limit.
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 7; i++) controller.enqueue(new Uint8Array(1_000_000).fill(0x20));
        controller.close();
      },
    });
    const streamed = await handle(
      new Request(`http://api.test/bundles/${txs.organizer}`, {
        method: 'PUT',
        body: stream,
        duplex: 'half',
      } as RequestInit),
      bindings,
      { now: () => T, chain },
    );
    expect(streamed.status).toBe(413);
    expect(requests).toEqual([]);
  });

  it('refuses a transaction the indexer does not know', async () => {
    const response = await put(txs.unknown, bundles.valid);
    expect([response.status, await response.text()]).toEqual([
      404,
      'No commitment with this transaction hash is indexed',
    ]);
    expect(await records()).toEqual([]);
  });

  it('refuses a commitment whose hosting period already ended', async () => {
    const response = await put(txs.organizer, bundles.valid, addMonths(T, HOSTING_MONTHS));
    expect(response.status).toBe(410);
  });

  it('refuses bytes that parse to a valid bundle but are not its canonical serialization (review H1)', async () => {
    // Each transaction commits exactly these bytes, and each parses to a bundle validateBundle accepts (the duplicate
    // key carries content JSON.parse drops): only the canonical check stands between them and hosting.
    for (const name of ['duplicateKey', 'spaced', 'reordered'] as const) {
      expect(() => validateBundle(JSON.parse(bundles[name]))).not.toThrow();
      const response = await put(txs[name], bundles[name]);
      expect([name, response.status, await response.text()]).toEqual([
        name,
        422,
        'Not canonical bundle bytes: upload exactly the downloaded bundle file (sorted keys, no whitespace, no duplicate keys)',
      ]);
    }
    // A byte order mark before canonical JSON: kept by the decoder, so the bytes are not taken for the canonical ones.
    const bom = await put(txs.bom, bundles.bom);
    expect([bom.status, await bom.text()]).toEqual([422, 'Not a bundle: the bytes are not UTF-8 JSON']);
    expect(await records()).toEqual([]);
    expect((await bindings.BUNDLES.list()).objects).toEqual([]);
    // The canonical bytes of a commitment are accepted (also the first test of this block).
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
  });

  it('refuses a bundle whose drand round is not the round its commitment names (review M1)', async () => {
    // The metadata names a round about a year after the bundle's: hosting must not count retention from it.
    const response = await put(txs.roundMismatch, bundles.roundMismatch);
    expect([response.status, await response.text()]).toEqual([
      409,
      'The bundle drawId or drand round differs from the commitment of this transaction',
    ]);
    expect(await records()).toEqual([]);
  });
});

describe('records keyed by txHash, bytes shared and reference counted (BR-07, B4)', () => {
  it('another commitment of the same bundle hash, uploaded first and then deleted, does not block the organizer', async () => {
    // Anyone can put the organizer's bundle hash in a transaction of their own (the round-before announcement is
    // public) and upload first: that record is theirs, and deleting it leaves no tombstone (Amendment 2).
    const squatter = await put(txs.other, bundles.valid);
    expect(squatter.status).toBe(201);
    expect(((await squatter.json()) as { owner: string }).owner).toBe(owners.other);
    expect(await release(bindings, txs.other, T)).toBe(true);
    expect(await stored(VALID_HASH)).toBe(false);
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    const served = await get(txs.organizer);
    expect([served.status, await served.text()]).toEqual([200, bundles.valid]);
  });

  it('removing one record keeps bytes another record still names; the last removal deletes them', async () => {
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    expect((await put(txs.other, bundles.valid)).status).toBe(201);
    expect(await release(bindings, txs.other, T)).toBe(true);
    // The organizer's link stays valid.
    const served = await get(txs.organizer);
    expect([served.status, await served.text()]).toEqual([200, bundles.valid]);
    expect((await get(txs.other)).status).toBe(404);
    expect(await release(bindings, txs.organizer, T)).toBe(true);
    expect(await stored(VALID_HASH)).toBe(false);
    expect(await release(bindings, txs.organizer, T)).toBe(false);
  });

  it('an operator takedown removes every record of the bytes and refuses any later upload of them', async () => {
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    expect((await put(txs.other, bundles.valid)).status).toBe(201);
    await takedown(bindings, VALID_HASH, T);
    expect(await records()).toEqual([]);
    expect(await stored(VALID_HASH)).toBe(false);
    for (const tx of [txs.organizer, txs.other]) {
      expect((await get(tx)).status).toBe(404);
      const again = await put(tx, bundles.valid);
      expect([again.status, await again.text()]).toEqual([
        410,
        'This bundle was taken down and cannot be hosted again',
      ]);
    }
    expect(await records()).toEqual([]);
  });
});

describe('owner quota (BR-17)', () => {
  it(`an organizer keeps at most ${OWNER_QUOTA} bundles hosted`, async () => {
    for (let i = 0; i < OWNER_QUOTA; i++)
      expect((await put(txs[`quota${i}` as keyof typeof txs], bundles.quota)).status).toBe(201);
    const over = await put(txs.quota20, bundles.quota);
    expect([over.status, await over.text()]).toEqual([
      403,
      `The organizer already hosts ${OWNER_QUOTA} bundles (the quota per organizer)`,
    ]);
    // Another organizer is not affected, and a freed slot can be used.
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    await release(bindings, txs.quota0, T);
    expect((await put(txs.quota20, bundles.quota)).status).toBe(201);
  });
});

describe('retention (BR-08): expires_at on read, Cron sweep (time injected)', () => {
  it('refuses a read at expiry and the Cron run at that time removes the record and its bytes', async () => {
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    const expiry = addMonths(T, HOSTING_MONTHS);
    expect((await get(txs.organizer, expiry - 1)).status).toBe(200);
    const late = await get(txs.organizer, expiry);
    expect([late.status, await late.text()]).toEqual([410, 'The hosting period of this bundle has ended']);
    // Refused before the sweep has run: the record is still there.
    expect(await records()).toEqual([txs.organizer]);
    await cron(expiry - 1);
    expect(await records()).toEqual([txs.organizer]);
    expect(await stored(VALID_HASH)).toBe(true);
    await cron(expiry);
    expect(await records()).toEqual([]);
    expect(await stored(VALID_HASH)).toBe(false);
  });
});

describe('retention base time = min(round time, first hosting time) (BR-08, plan step 10b, ADR Amendment 5)', () => {
  const hostedUntil = async (response: Response) => {
    expect(response.status).toBe(201);
    return ((await response.json()) as { expiresAt: number }).expiresAt;
  };
  it('a round far after the upload: the bundle is hosted 12 months from the upload, not from the round', async () => {
    // The fixture's round is three years after this upload.
    const uploaded = addMonths(T, -36);
    const expiresAt = await hostedUntil(await put(txs.organizer, bundles.valid, uploaded));
    expect(expiresAt).toBe(addMonths(uploaded, HOSTING_MONTHS));
    expect((await get(txs.organizer, expiresAt - 1)).status).toBe(200);
    expect((await get(txs.organizer, expiresAt)).status).toBe(410);
    await cron(expiresAt);
    expect(await records()).toEqual([]);
    expect(await stored(VALID_HASH)).toBe(false);
  });
  it('the largest round validateBundle accepts is hosted 12 months from the upload (formerly refused, review M1)', async () => {
    expect(await hostedUntil(await put(txs.farRound, bundles.farRound))).toBe(addMonths(T, HOSTING_MONTHS));
  });
  it('a round before the upload: the bundle is hosted until 12 months after the round', async () => {
    const uploaded = addMonths(T, 1);
    expect(await hostedUntil(await put(txs.organizer, bundles.valid, uploaded))).toBe(addMonths(T, HOSTING_MONTHS));
  });
  it('an expired record uploaded again before its round gets no new period: 410, nothing stored', async () => {
    const first = addMonths(T, -36);
    const expiresAt = await hostedUntil(await put(txs.organizer, bundles.valid, first));
    await cron(expiresAt);
    expect(await records()).toEqual([]);
    // Two years before the round, a year after the first hosting: counting from this upload would host it again.
    const again = await put(txs.organizer, bundles.valid, addMonths(first, 13));
    expect([again.status, await again.text()]).toEqual([
      410,
      'The hosting period of this draw has ended (12 months after its round or its first hosting, whichever came first)',
    ]);
    expect(await records()).toEqual([]);
    expect(await stored(VALID_HASH)).toBe(false);
  });
  it('a record removed before its expiry and uploaded again keeps the expiry of its first hosting', async () => {
    const first = addMonths(T, -36);
    const expiresAt = await hostedUntil(await put(txs.organizer, bundles.valid, first));
    expect(await release(bindings, txs.organizer, addMonths(first, 1))).toBe(true);
    expect(await hostedUntil(await put(txs.organizer, bundles.valid, addMonths(first, 2)))).toBe(expiresAt);
  });
  it('the first hosting time is kept until 12 months after the round, then swept', async () => {
    const firstHosting = async () =>
      (
        await bindings.DB.prepare('SELECT tx_hash FROM first_hosting ORDER BY tx_hash').all<{ tx_hash: string }>()
      ).results.map((r) => r.tx_hash);
    await hostedUntil(await put(txs.organizer, bundles.valid, addMonths(T, -36)));
    await hostedUntil(await put(txs.farRound, bundles.farRound));
    await cron(addMonths(T, HOSTING_MONTHS) - 1);
    expect(await firstHosting()).toEqual([txs.organizer, txs.farRound].sort());
    // From 12 months after the round the round time alone ends any period; a round no date represents is kept.
    await cron(addMonths(T, HOSTING_MONTHS));
    expect(await firstHosting()).toEqual([txs.farRound]);
  });
});

describe('bytes follow live records under concurrent requests (review M2; interleavings injected)', () => {
  it('a takedown or deletion between the record write and the byte write leaves no bytes and fails the upload', async () => {
    // (a) The takedown deletes the object before the upload writes it; the write puts it back.
    const takenDown = await put(
      txs.organizer,
      bundles.valid,
      T,
      interleave('put', () => takedown(bindings, VALID_HASH, T)),
    );
    expect([takenDown.status, await takenDown.text()]).toEqual([
      410,
      'This bundle was taken down and cannot be hosted again',
    ]);
    expect(await records()).toEqual([]);
    expect(await stored(VALID_HASH)).toBe(false);
  });

  it('an owner deletion between the record write and the byte write leaves no bytes; uploading again hosts them', async () => {
    const removed = await put(
      txs.organizer,
      bundles.valid,
      T,
      interleave('put', () => release(bindings, txs.organizer, T)),
    );
    expect([removed.status, await removed.text()]).toEqual([
      409,
      'This hosting record was removed by a concurrent request; upload again to host it',
    ]);
    expect(await records()).toEqual([]);
    expect(await stored(VALID_HASH)).toBe(false);
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    // The same on the 200 path (the record exists and the bytes are written again).
    const again = await put(
      txs.organizer,
      bundles.valid,
      T,
      interleave('put', () => takedown(bindings, VALID_HASH, T)),
    );
    expect(again.status).toBe(410);
    expect(await stored(VALID_HASH)).toBe(false);
  });

  it('bytes left by a failed deletion are reclaimed by the Cron reconciliation, never bytes a record names', async () => {
    // (b) The record goes, the R2 delete fails: the claim stays, so no upload can name the bytes meanwhile.
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    expect((await put(txs.quota0, bundles.quota)).status).toBe(201);
    await expect(
      release(
        interleave('delete', async () => {}, true),
        txs.organizer,
        T,
      ),
    ).rejects.toThrow('injected R2 failure');
    expect(await records()).toEqual([txs.quota0]);
    expect(await stored(VALID_HASH)).toBe(true);
    const blocked = await put(txs.other, bundles.valid);
    expect([blocked.status, await blocked.text()]).toEqual([
      409,
      'These bytes are being deleted by a concurrent request; retry',
    ]);
    // A fresh claim is left to its holder; a stale one is finished.
    await cron(T + CLAIM_STALE - 1);
    expect(await stored(VALID_HASH)).toBe(true);
    await cron(T + CLAIM_STALE);
    expect(await stored(VALID_HASH)).toBe(false);
    expect(await stored(QUOTA_HASH)).toBe(true);
    expect((await put(txs.other, bundles.valid)).status).toBe(201);
    // A request that stopped after deleting its record and before claiming the bytes: the scan deletes them.
    await bindings.DB.prepare('DELETE FROM hosted WHERE tx_hash = ?').bind(txs.other).run();
    await cron(T);
    expect(await stored(VALID_HASH)).toBe(false);
    expect(await stored(QUOTA_HASH)).toBe(true);
    const served = await get(txs.quota0);
    expect([served.status, await served.text()]).toEqual([200, bundles.quota]);
  });

  it('the reconciliation scans the bucket a page per run, resuming where the last run stopped', async () => {
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    // Orphans sorting before and after the hosted object, one more than a page.
    const orphans = Array.from({ length: RECONCILE_LIMIT + 1 }, (_, i) => i.toString(16).padStart(64, '0'));
    for (const hash of orphans) await bindings.BUNDLES.put(objectKey(hash), 'orphan');
    await cron(T);
    const left = (await bindings.BUNDLES.list({ limit: RECONCILE_LIMIT })).objects.map((o) => o.key);
    expect(left).toEqual([objectKey(orphans[RECONCILE_LIMIT]), objectKey(VALID_HASH)].sort());
    await cron(T);
    expect((await bindings.BUNDLES.list()).objects.map((o) => o.key)).toEqual([objectKey(VALID_HASH)]);
    const served = await get(txs.organizer);
    expect([served.status, await served.text()]).toEqual([200, bundles.valid]);
    // Writing a page and one of orphans one by one takes seconds on a loaded machine; the default 5 s timed out.
  }, 60_000);

  it("an upload while the last record's bytes are being deleted is refused, and hosts them when retried", async () => {
    // (c) The deletion has counted no record and claimed the bytes; the upload arrives before the R2 delete.
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    let during: Response | undefined;
    const deleting = interleave('delete', async () => {
      during = await put(txs.other, bundles.valid);
    });
    expect(await release(deleting, txs.organizer, T)).toBe(true);
    expect([during?.status, await during?.text()]).toEqual([
      409,
      'These bytes are being deleted by a concurrent request; retry',
    ]);
    expect(await records()).toEqual([]);
    expect(await stored(VALID_HASH)).toBe(false);
    expect((await put(txs.other, bundles.valid)).status).toBe(201);
    const served = await get(txs.other);
    expect([served.status, await served.text()]).toEqual([200, bundles.valid]);
  });
});
