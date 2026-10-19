// PD2 measurement Worker (apps/api/bench/cpu.mjs starts it in local workerd; never deployed). It times, inside the
// isolate, the CPU-bound work of the upload gate on the bytes it receives: the production inspectBundleBytes (SHA-256
// of the bytes, UTF-8 decode, JSON.parse, the canonical check, validateBundle; /inspect), each of those steps alone
// (/steps), and the gate's
// two chain reads
// (BlockfrostChain.commitmentOwner and readCommitment: CBOR decoding, blake2b, Ed25519) against recorded answers.
// Local workerd advances performance.now() during computation; deployed Workers do not (timers move only on I/O), so
// this Worker is meaningful only locally.
import { BlockfrostChain } from '@giveaway/chain';
import { canonicalize, sha256, validateBundle } from '@giveaway/protocol';
import fixture from '../test/chain-fixture.json';
import { inspectBundleBytes } from '../src/bundles.ts';

type Answer = { status: number; headers: Record<string, string>; body: string };
const answers = fixture.answers as Record<string, Answer>;
const replay = async (url: string) => {
  const answer = answers[url.slice(fixture.indexer.length)];
  if (!answer) throw new Error(`no recorded answer for ${url}`);
  return new Response(answer.body === '' ? null : answer.body, { status: answer.status, headers: answer.headers });
};

async function timed<T>(work: () => Promise<T> | T): Promise<number> {
  const start = performance.now();
  await work();
  return performance.now() - start;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/chain') {
      const chain = new BlockfrostChain(fixture.indexer, replay);
      const tx = fixture.txs.organizer;
      const ms = await timed(async () => chain.readCommitment(tx, await chain.commitmentOwner(tx)));
      return Response.json({ chainMs: ms });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    const result: Record<string, number> = { bytes: bytes.length };
    // /inspect does only the production step, so the process CPU reading around it counts nothing else.
    if (url.pathname === '/inspect') {
      result.inspectMs = await timed(() => inspectBundleBytes(bytes));
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
