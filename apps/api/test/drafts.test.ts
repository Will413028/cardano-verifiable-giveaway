import { decodeBech32 } from '@giveaway/chain';
import { BUNDLE_BYTE_LIMIT, type DraftOperationName, sha256 } from '@giveaway/protocol';
import { createScheduledController, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DRAFT_QUOTA, DRAFT_RETENTION, draftObjectKey, sweepDrafts } from '../src/drafts.ts';
import worker, { type Env, handle } from '../src/index.ts';
import fixture from './chain-fixture.json';
import { authorization, draftAuthorization, rewardAddress, SEEDS, secretOf, type Who } from './sign.ts';

// Server drafts (plan step 12; BR-12, BR-18; B3, B5) against real local D1 and R2 (Miniflare), with signatures made by
// the fixture's test keys (test/sign.ts). Time is injected: requests take `now`, the Cron its scheduled time.
type Answer = { status: number; headers: Record<string, string>; body: string };
const answers = fixture.answers as Record<string, Answer>;
const PAGE = 'http://127.0.0.1:4320';
const bindings = env as unknown as Env;
const T = 1_800_000_000;
const DAY = 86400;
const ID = 'a1'.repeat(16);
const OTHER_ID = 'b2'.repeat(16);
const content = (text: string) => new TextEncoder().encode(text);
const draftOf = (entrants: string) =>
  content(JSON.stringify({ format: 'giveaway-draft-1', mode: 'preprod', entrants, winners: '1', round: '9' }));
const DRAFT = draftOf('alice\nbob');

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
        'CF-Connecting-IP': ip ?? `198.51.100.${++client % 250}`,
        ...(auth ? { Authorization: auth } : {}),
      },
    }),
    bindings,
    { now: () => at },
  );
const sign = (
  operation: DraftOperationName,
  at: number,
  extra: Partial<Parameters<typeof draftAuthorization>[1]> = {},
  who: Who = 'organizer',
) =>
  draftAuthorization(who, {
    operation,
    at,
    ...(operation === 'draft-list' ? {} : { draft: ID }),
    ...extra,
  });
type Auth = string | Promise<string>;
const save = async (
  at: number,
  body: Uint8Array = DRAFT,
  { id = ID, who = 'organizer' as Who, auth }: { id?: string; who?: Who; auth?: Auth } = {},
) =>
  request('PUT', `/drafts/${id}`, at, {
    body,
    auth: await (auth ?? sign('draft-save', at, { draft: id, content: await sha256(body) }, who)),
  });
const load = async (
  at: number,
  { id = ID, who = 'organizer' as Who, auth }: { id?: string; who?: Who; auth?: Auth } = {},
) => request('GET', `/drafts/${id}`, at, { auth: await (auth ?? sign('draft-load', at, { draft: id }, who)) });
const remove = async (
  at: number,
  { id = ID, who = 'organizer' as Who, auth }: { id?: string; who?: Who; auth?: Auth } = {},
) => request('DELETE', `/drafts/${id}`, at, { auth: await (auth ?? sign('draft-delete', at, { draft: id }, who)) });
const list = async (at: number, who: Who = 'organizer') =>
  request('GET', '/drafts', at, { auth: await sign('draft-list', at, {}, who) });
const answer = async (response: Response) => [response.status, await response.text()];
const rows = () => bindings.DB.prepare('SELECT COUNT(*) AS n FROM drafts').first('n');
const objects = async () => (await bindings.BUNDLES.list({ prefix: 'drafts/' })).objects.map((o) => o.key);
const cron = (at: number) => worker.scheduled(createScheduledController({ scheduledTime: at * 1000 }), bindings);
const idOf = (n: number) => n.toString(16).padStart(32, '0');

beforeEach(async () => {
  await bindings.DB.batch(['drafts', 'used_nonces'].map((table) => bindings.DB.prepare(`DELETE FROM ${table}`)));
  await bindings.DB.prepare('UPDATE nonce_sweep SET swept_through = 0').run();
  const listed = await bindings.BUNDLES.list();
  if (listed.objects.length) await bindings.BUNDLES.delete(listed.objects.map((o) => o.key));
});

describe('server drafts (BR-12, BR-18)', () => {
  it('saves, lists, loads the same bytes, replaces and deletes a draft, each with its own signature', async () => {
    const saved = await save(T);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ id: ID, savedAt: T, expiresAt: T + DRAFT_RETENTION, size: DRAFT.length });
    const loaded = await load(T + 1);
    expect(loaded.status).toBe(200);
    expect(loaded.headers.get('Cache-Control')).toBe('no-store');
    expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(DRAFT);
    const replacement = draftOf('carol');
    expect((await save(T + 2, replacement)).status).toBe(200);
    // A replacement writes new bytes and deletes the replaced ones: one record, one object.
    expect([await rows(), (await objects()).length]).toEqual([1, 1]);
    expect(new Uint8Array(await (await load(T + 3)).arrayBuffer())).toEqual(replacement);
    expect(await (await list(T + 4)).json()).toEqual({
      drafts: [{ id: ID, savedAt: T + 2, expiresAt: T + 2 + DRAFT_RETENTION, size: replacement.length }],
    });
    expect(await answer(await remove(T + 5))).toEqual([200, JSON.stringify({ id: ID, deleted: true })]);
    expect([await rows(), (await objects()).length]).toEqual([0, 0]);
    expect((await load(T + 6)).status).toBe(404);
    // B3: what is kept about the signatures is their nonce use, nothing else (the refused load used none).
    expect(await bindings.DB.prepare('SELECT COUNT(*) AS n FROM used_nonces').first('n')).toBe(6);
  });

  it('refuses unsigned access: no route answers or stores anything without a draft signature', async () => {
    expect((await save(T)).status).toBe(200);
    const unsigned = [
      await request('PUT', `/drafts/${OTHER_ID}`, T, { body: DRAFT }),
      await request('GET', `/drafts/${ID}`, T),
      await request('DELETE', `/drafts/${ID}`, T),
      await request('GET', '/drafts', T),
    ];
    for (const response of unsigned)
      expect(await answer(response)).toEqual([
        401,
        'This operation needs the draft signature (Authorization: CIP30 <COSE_Sign1> <COSE_Key>)',
      ]);
    expect(await answer(await load(T, { auth: 'Bearer token' }))).toEqual([
      401,
      'Malformed Authorization header (expected CIP30 <COSE_Sign1 hex> <COSE_Key hex>)',
    ]);
    // Another key claiming the organizer's reward address: the signature does not verify for that address.
    const forged = sign('draft-load', T, { secret: secretOf(SEEDS.other), address: rewardAddress('organizer') });
    expect(await answer(await load(T, { auth: forged }))).toEqual([401, 'The signature does not verify']);
    expect([await rows(), (await objects()).length]).toEqual([1, 1]);
  });

  it(`refuses a draft past the quota of ${DRAFT_QUOTA} per identity, and only for that identity`, async () => {
    for (let n = 0; n < DRAFT_QUOTA; n++) expect((await save(T + n, DRAFT, { id: idOf(n) })).status).toBe(200);
    const over = await save(T + 10, DRAFT, { id: idOf(DRAFT_QUOTA) });
    expect(await answer(over)).toEqual([
      403,
      `This wallet already keeps ${DRAFT_QUOTA} server drafts (the quota); delete one first`,
    ]);
    // Nothing of the refused draft stays: no record, no bytes.
    expect([await rows(), (await objects()).length]).toEqual([DRAFT_QUOTA, DRAFT_QUOTA]);
    // Replacing a draft the identity already keeps is not a new one.
    expect((await save(T + 11, draftOf('x'), { id: idOf(0) })).status).toBe(200);
    // Another identity has its own quota.
    expect((await save(T + 12, DRAFT, { id: idOf(DRAFT_QUOTA), who: 'other' })).status).toBe(200);
    // After a deletion, or once a draft has expired, the identity may save a new one.
    expect((await remove(T + 13, { id: idOf(1) })).status).toBe(200);
    expect((await save(T + 14, DRAFT, { id: idOf(DRAFT_QUOTA) })).status).toBe(200);
    expect((await save(T + 15, DRAFT, { id: idOf(DRAFT_QUOTA + 1) })).status).toBe(403);
    expect((await save(T + 2 + DRAFT_RETENTION, DRAFT, { id: idOf(DRAFT_QUOTA + 1) })).status).toBe(200);
  });

  it('refuses a draft over the protocol byte limit', async () => {
    const big = new Uint8Array(BUNDLE_BYTE_LIMIT + 1).fill(0x20);
    expect(await answer(await save(T, big))).toEqual([413, `Draft exceeds ${BUNDLE_BYTE_LIMIT} bytes`]);
    expect([await rows(), (await objects()).length]).toEqual([0, 0]);
  });

  it('keeps drafts only, with the public labels only: other CSV columns and anything else are refused', async () => {
    const refused: [Uint8Array, string][] = [
      [
        draftOf('label,email\nann,ann@example.com'),
        'A server draft holds the public labels only (no other CSV columns)',
      ],
      [draftOf('ann\nann'), 'Server draft participants: Duplicate participant labels are not allowed'],
      [content('{"format":"giveaway-pending-2"}'), 'This file is not an Open Draw draft'],
      [content('not json'), 'Not a server draft: '],
    ];
    for (const [body, reason] of refused)
      expect(await answer(await save(T, body))).toEqual([422, expect.stringContaining(reason)]);
    expect([await rows(), (await objects()).length]).toEqual([0, 0]);
    // Labels holding a comma or a quote travel as a quoted label column, which reads back to the same labels.
    expect((await save(T, draftOf('label\n"a, b"\n"say ""hi"""'))).status).toBe(200);
  });

  it('refuses a save whose signed content hash is not the hash of the uploaded bytes', async () => {
    const auth = sign('draft-save', T, { content: await sha256(content('something else')) });
    expect(await answer(await save(T, DRAFT, { auth }))).toEqual([
      409,
      'The signed message names other content than the uploaded draft',
    ]);
    expect([await rows(), (await objects()).length]).toEqual([0, 0]);
  });
});

describe('30 days after the last save (B5)', () => {
  it('a draft is refused from 30 days after its last save, and the Cron deletes its record and bytes', async () => {
    expect((await save(T)).status).toBe(200);
    expect((await save(T + DAY, DRAFT, { id: OTHER_ID })).status).toBe(200);
    expect((await load(T + DRAFT_RETENTION - 1)).status).toBe(200);
    expect((await load(T + DRAFT_RETENTION)).status).toBe(404);
    // Before the 30 days the Cron keeps everything.
    await cron(T + DRAFT_RETENTION - 1);
    expect([await rows(), (await objects()).length]).toEqual([2, 2]);
    await cron(T + DRAFT_RETENTION);
    expect(await bindings.DB.prepare('SELECT id FROM drafts').all()).toMatchObject({ results: [{ id: OTHER_ID }] });
    expect(await objects()).toEqual([expect.stringMatching(new RegExp(`^drafts/0*${T + DAY}/`))]);
    await cron(T + DAY + DRAFT_RETENTION);
    expect([await rows(), (await objects()).length]).toEqual([0, 0]);
  });

  it('a save restarts the 30 days of that draft', async () => {
    expect((await save(T)).status).toBe(200);
    expect((await save(T + 20 * DAY)).status).toBe(200);
    await cron(T + DRAFT_RETENTION);
    expect((await load(T + DRAFT_RETENTION)).status).toBe(200);
    expect((await load(T + 20 * DAY + DRAFT_RETENTION)).status).toBe(404);
  });

  it('bytes no record names (a save that stopped before its record) are deleted 30 days after their save time', async () => {
    const orphan = draftObjectKey(T, 'f'.repeat(32));
    await bindings.BUNDLES.put(orphan, DRAFT);
    const young = draftObjectKey(T + DAY, 'e'.repeat(32));
    await bindings.BUNDLES.put(young, DRAFT);
    await cron(T + DRAFT_RETENTION);
    expect(await objects()).toEqual([young]);
    // The draft sweep lists only drafts/: hosted bundle bytes (left to the bundle sweeps) are not draft objects.
    const bundleKey = `bundles/${'0'.repeat(64)}`;
    await bindings.BUNDLES.put(bundleKey, DRAFT);
    await sweepDrafts(bindings, T + 10 * DRAFT_RETENTION);
    expect(await objects()).toEqual([]);
    expect(await bindings.BUNDLES.head(bundleKey)).not.toBeNull();
  });
});

describe('signed draft access', () => {
  it('a signature for one operation, draft or format is not accepted for another', async () => {
    expect((await save(T)).status).toBe(200);
    // A draft-load signature does not delete, a draft-delete signature does not save or list.
    expect(await answer(await remove(T, { auth: sign('draft-load', T) }))).toEqual([
      401,
      'The signed message authorizes "draft-load", not "draft-delete"',
    ]);
    expect(await answer(await save(T, DRAFT, { auth: sign('draft-delete', T) }))).toEqual([
      401,
      'The signed message authorizes "draft-delete", not "draft-save"',
    ]);
    expect(
      await answer(await request('GET', '/drafts', T, { auth: await sign('draft-load', T, { draft: 'all' }) })),
    ).toEqual([401, 'The signed message is not a draft operation']);
    // A signature for one draft does not reach another.
    expect(await answer(await load(T, { id: OTHER_ID, auth: sign('draft-load', T) }))).toEqual([
      401,
      'The signed message names another draft',
    ]);
    // An owner operation on a hosted bundle is not a draft operation, and a draft operation is not an owner one.
    const ownerDelete = authorization('organizer', {
      operation: 'delete',
      txHash: ID.repeat(2),
      bundleHash: ID.repeat(2),
      at: T,
    });
    expect(await answer(await remove(T, { auth: ownerDelete }))).toEqual([
      401,
      'The signed message is not a draft operation',
    ]);
    expect(
      await answer(await request('DELETE', `/bundles/${ID.repeat(2)}`, T, { auth: await sign('draft-delete', T) })),
    ).toEqual([401, 'The signed message is not an owner operation']);
    expect([await rows(), (await objects()).length]).toEqual([1, 1]);
  });

  it("another identity's key finds no draft, and a key that is not the wallet's stake key is refused", async () => {
    expect((await save(T)).status).toBe(200);
    // The other identity signs validly for itself: the organizer's draft is not its draft.
    expect((await load(T, { who: 'other' })).status).toBe(404);
    expect((await remove(T, { who: 'other' })).status).toBe(404);
    expect(await (await list(T, 'other')).json()).toEqual({ drafts: [] });
    // Its save under the same id is its own draft and leaves the organizer's alone.
    expect((await save(T, draftOf('other'), { who: 'other' })).status).toBe(200);
    expect(new Uint8Array(await (await load(T + 1)).arrayBuffer())).toEqual(DRAFT);
    // A payment key signing for a base address: a valid signature, but not by a stake key for its reward address.
    const paymentBase = Uint8Array.from([0x00, ...paymentKeyHash(), ...rewardAddress('organizer').subarray(1)]);
    const refused = [403, "Drafts are signed with the wallet's stake key (sign with its preprod reward address)"];
    for (const operation of ['draft-load', 'draft-delete'] as const)
      expect(
        await answer(
          await request(operation === 'draft-load' ? 'GET' : 'DELETE', `/drafts/${ID}`, T + 2, {
            auth: await sign(operation, T + 2, { secret: secretOf(1), address: paymentBase }),
          }),
        ),
      ).toEqual(refused);
    expect(new Uint8Array(await (await load(T + 3)).arrayBuffer())).toEqual(DRAFT);
  });

  it('refuses a reused signed message, one signed for another site, and an expired one', async () => {
    expect((await save(T)).status).toBe(200);
    const once = await sign('draft-load', T);
    expect((await load(T, { auth: once })).status).toBe(200);
    expect(await answer(await load(T, { auth: once }))).toEqual([
      409,
      'This signed message was already used (one-time nonce); sign the operation again',
    ]);
    expect(await answer(await load(T, { auth: sign('draft-load', T, { domain: 'evil.example' }) }))).toEqual([
      401,
      'The signed message was written for another site',
    ]);
    expect(await answer(await load(T + 300, { auth: sign('draft-load', T) }))).toEqual([
      401,
      'The signed message has expired (5 minutes); sign again',
    ]);
  });

  it('limits every draft route per client address, reads included', { timeout: 20000 }, async () => {
    const second = (Date.now() / 1000) % 60;
    if (second > 50) await new Promise((resolve) => setTimeout(resolve, (61 - second) * 1000));
    const ip = '203.0.113.77';
    for (let i = 0; i < 20; i++) expect((await request('GET', `/drafts/${ID}`, T, { ip })).status).toBe(401);
    expect((await request('GET', '/drafts', T, { ip })).status).toBe(429);
    expect((await request('GET', `/drafts/${ID}`, T, { ip: '203.0.113.78' })).status).toBe(401);
  });
});

function paymentKeyHash(): number[] {
  const utxos = JSON.parse(answers[`/txs/${fixture.txs.organizer}/utxos`].body) as { inputs: { address: string }[] };
  return [...decodeBech32(utxos.inputs[0].address).bytes.subarray(1, 29)];
}
