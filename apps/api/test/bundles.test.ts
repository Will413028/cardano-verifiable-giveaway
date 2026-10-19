import { BlockfrostChain } from '@giveaway/chain';
import { BUNDLE_BYTE_LIMIT, sha256 } from '@giveaway/protocol';
import { createScheduledController, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { objectKey, OWNER_QUOTA, release, takedown } from '../src/bundles.ts';
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
const call = (method: string, txHash: string, at: number, body?: BodyInit) =>
  handle(new Request(`http://api.test/bundles/${txHash}`, { method, body, headers: { Origin: PAGE } }), bindings, {
    now: () => at,
    chain,
  });
const put = (txHash: string, body: BodyInit, at = T) => call('PUT', txHash, at, body);
const get = (txHash: string, at = T) => call('GET', txHash, at);
const stored = async (bundleHash: string) => (await bindings.BUNDLES.head(objectKey(bundleHash))) !== null;
const records = async () =>
  (await bindings.DB.prepare('SELECT tx_hash FROM hosted ORDER BY tx_hash').all<{ tx_hash: string }>()).results.map(
    (r) => r.tx_hash,
  );
const VALID_HASH = await sha256(bundles.valid);

beforeEach(async () => {
  requests = [];
  await bindings.DB.batch([bindings.DB.prepare('DELETE FROM hosted'), bindings.DB.prepare('DELETE FROM tombstones')]);
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
});

describe('records keyed by txHash, bytes shared and reference counted (BR-07, B4)', () => {
  it('another commitment of the same bundle hash, uploaded first and then deleted, does not block the organizer', async () => {
    // Anyone can put the organizer's bundle hash in a transaction of their own (the round-before announcement is
    // public) and upload first: that record is theirs, and deleting it leaves no tombstone (Amendment 2).
    const squatter = await put(txs.other, bundles.valid);
    expect(squatter.status).toBe(201);
    expect(((await squatter.json()) as { owner: string }).owner).toBe(owners.other);
    expect(await release(bindings, txs.other)).toBe(true);
    expect(await stored(VALID_HASH)).toBe(false);
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    const served = await get(txs.organizer);
    expect([served.status, await served.text()]).toEqual([200, bundles.valid]);
  });

  it('removing one record keeps bytes another record still names; the last removal deletes them', async () => {
    expect((await put(txs.organizer, bundles.valid)).status).toBe(201);
    expect((await put(txs.other, bundles.valid)).status).toBe(201);
    expect(await release(bindings, txs.other)).toBe(true);
    // The organizer's link stays valid.
    const served = await get(txs.organizer);
    expect([served.status, await served.text()]).toEqual([200, bundles.valid]);
    expect((await get(txs.other)).status).toBe(404);
    expect(await release(bindings, txs.organizer)).toBe(true);
    expect(await stored(VALID_HASH)).toBe(false);
    expect(await release(bindings, txs.organizer)).toBe(false);
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
    await release(bindings, txs.quota0);
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
    const run = async (at: number) => {
      await worker.scheduled(createScheduledController({ scheduledTime: at * 1000, cron: '17 * * * *' }), bindings);
    };
    await run(expiry - 1);
    expect(await records()).toEqual([txs.organizer]);
    expect(await stored(VALID_HASH)).toBe(true);
    await run(expiry);
    expect(await records()).toEqual([]);
    expect(await stored(VALID_HASH)).toBe(false);
  });
});
