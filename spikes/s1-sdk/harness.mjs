// Runtime-neutral checks; the same code runs in Node, Chrome and workerd.
// Each step races a 10 s timer so a hang (e.g. a crypto init that never settles) is reported instead of stalling the run.
const attempt = async f => {
  let timer;
  try { return await Promise.race([f(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout 10s')), 10000); })]); }
  catch (e) { return { error: String(e?.message ?? e).slice(0, 200) }; }
  finally { clearTimeout(timer); }
};
export async function run(opt, data) {
  const out = { option: opt.name, init: opt.init ? await attempt(async () => { await opt.init(); return true; }) : 'none', txs: [], cose: null };
  for (const t of data.txs) {
    const r = { txHash: t.txHash };
    r.hash = await attempt(async () => (await opt.txHash(t.cbor)) === t.txHash);
    r.mutatedBodyDiffers = await attempt(async () => (await opt.txHash(t.mutatedBody)) !== t.txHash);
    if (opt.txHashNaive) r.naiveHash = await attempt(async () => (await opt.txHashNaive(t.cbor)) === t.txHash);
    if (opt.auxHashNaive) r.naiveAux = await attempt(async () => (await opt.auxHashNaive(t.cbor)).computed === t.declaredAux);
    r.aux = await attempt(async () => { const a = await opt.auxHash(t.cbor); return a.computed === t.declaredAux && a.declared === t.declaredAux; });
    r.mutatedAuxDiffers = await attempt(async () => (await opt.auxHash(t.mutatedAux)).computed !== t.declaredAux);
    out.txs.push(r);
  }
  for (const [label, fn] of [['cose', opt.verifyCose], ['coseUnwrapped', opt.verifyCoseUnwrapped]]) {
    if (!fn) continue;
    const res = { agree: 0, wrong: [] };
    for (const v of data.vectors) {
      const got = await attempt(async () => await fn(v, v.payload, v.address));
      if (got === v.expect) res.agree++; else res.wrong.push(`${v.id}: ${JSON.stringify(got)}`);
    }
    out[label] = res;
  }
  out.ok = out.txs.every(r => r.hash === true && r.mutatedBodyDiffers === true && r.aux === true && r.mutatedAuxDiffers === true) && out.cose?.wrong.length === 0;
  return out;
}
