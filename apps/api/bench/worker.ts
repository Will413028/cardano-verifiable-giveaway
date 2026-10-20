// PD2 measurement Worker (apps/api/bench/cpu.mjs starts it in local workerd; never deployed). It times, inside the
// isolate, the CPU-bound work of the upload gate on the bytes it receives: the production inspectBundleBytes (SHA-256
// of the bytes, UTF-8 decode, JSON.parse, the hosting cap, the canonical check, validateBundle; /inspect), each of those
// steps alone (/steps), the gate's two chain reads (BlockfrostChain.commitmentOwner and readCommitment: CBOR decoding,
// blake2b, Ed25519) against recorded answers (/chain), both in one request (/gate), and a request that only receives
// the body (/noop: the per-request cost of the local HTTP stack, which every other reading includes).
// Local workerd advances performance.now() during computation; deployed Workers do not (timers move only on I/O), so
// this Worker is meaningful only locally.
import { BlockfrostChain, readCommitmentTransaction } from '@giveaway/chain';
import { canonicalize, sha256, validateBundle } from '@giveaway/protocol';
import fixture from '../test/chain-fixture.json';
import { HttpError, inspectBundleBytes } from '../src/bundles.ts';

type Answer = { status: number; headers: Record<string, string>; body: string };
const answers = fixture.answers as Record<string, Answer>;
const replay = async (url: string) => {
  const answer = answers[url.slice(fixture.indexer.length)];
  if (!answer) throw new Error(`no recorded answer for ${url}`);
  return new Response(answer.body === '' ? null : answer.body, { status: answer.status, headers: answer.headers });
};
const chainReads = async () => {
  const chain = new BlockfrostChain(fixture.indexer, replay);
  const tx = fixture.txs.organizer;
  await chain.readCommitment(tx, await chain.commitmentOwner(tx));
};

async function timed<T>(work: () => Promise<T> | T): Promise<number> {
  const start = performance.now();
  await work();
  return performance.now() - start;
}
// The gate's verdict on the bytes: refused bodies (the adversarial non-bundles) are measured too.
async function inspect(bytes: Uint8Array): Promise<number | null> {
  try {
    await inspectBundleBytes(bytes);
    return null;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // `k` repetitions inside one request: the in-isolate clock ticks in whole milliseconds, so a sub-millisecond step
    // is read as the total over k runs divided by k.
    const k = Number(url.searchParams.get('k') ?? 1);
    if (url.pathname === '/chain')
      return Response.json({
        chainMs:
          (await timed(async () => {
            for (let i = 0; i < k; i++) await chainReads();
          })) / k,
      });
    // One of the two transaction readings the chain reads make (CBOR decoding, blake2b, the Ed25519 witness checks).
    if (url.pathname === '/transaction') {
      const cbor = JSON.parse(answers[`/txs/${fixture.txs.organizer}/cbor`].body).cbor as string;
      return Response.json({
        transactionMs:
          (await timed(() => {
            for (let i = 0; i < k; i++) readCommitmentTransaction(cbor, fixture.txs.organizer);
          })) / k,
      });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const result: Record<string, number | null> = { bytes: bytes.length };
    if (url.pathname === '/noop') return Response.json(result);
    // /inspect does only the production step, so the process CPU reading around it counts nothing else.
    if (url.pathname === '/inspect') {
      result.inspectMs =
        (await timed(async () => {
          for (let i = 0; i < k; i++) result.refused = await inspect(bytes);
        })) / k;
      return Response.json(result);
    }
    if (url.pathname === '/gate') {
      result.gateMs =
        (await timed(async () => {
          for (let i = 0; i < k; i++) {
            result.refused = await inspect(bytes);
            await chainReads();
          }
        })) / k;
      return Response.json(result);
    }
    result.sha256Ms = await timed(() => sha256(bytes));
    let text = '';
    result.decodeMs = await timed(() => {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    });
    let value: unknown;
    result.parseMs = await timed(() => {
      value = JSON.parse(text);
    });
    result.canonicalMs = await timed(() => canonicalize(value) === text);
    result.validateMs = await timed(() => validateBundle(value));
    return Response.json(result);
  },
};
