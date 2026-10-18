// Builds the same commitment with each SDK and inspects the result with the minimal reader.
import { commitmentFields, auxHash, txHash, txParts } from './options/minimal.mjs';
export async function checkBuild(builder, s) {
  try {
    const hex = await builder.build(s);
    const f = commitmentFields(hex); const a = auxHash(hex);
    return { option: builder.name, bytes: hex.length / 2, fee: String(txParts(hex).body.get(2)), cbor: hex, ttl: f.ttl === BigInt(s.ttlSlot), requiredSigners: f.requiredSigners.includes(s.stakeKeyHash),
      metadata: f.metadataLabels.includes(s.label), auxHashMatches: a.computed !== null && a.computed === a.declared, txHash: txHash(hex),
      ok: f.ttl === BigInt(s.ttlSlot) && f.requiredSigners.includes(s.stakeKeyHash) && f.metadataLabels.includes(s.label) && a.computed === a.declared };
  } catch (e) { return { option: builder.name, ok: false, error: String(e?.message ?? e).slice(0, 300) }; }
}
