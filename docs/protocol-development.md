# Development protocol

This is an implementation default, not frozen protocol v1. The metadata/quicknet/SHA-256 ranking/15-confirmation/NFC defaults will be finalized after the deferred preprod experiments. The runnable demo is not an on-chain giveaway.

## Bundle and canonical commitment

`version: development-1`, `algorithm: sha256-ranking-1`, `drawId`, `entrants`, `rules: { winners }`, and `drand: { chainHash, round }` are the only bundle fields. Labels must be trimmed NFC strings, unique, and free of control characters or lone surrogates. CSV imports use only the `label` column and discard contact columns. Email and phone-shaped labels are rejected. The development limits are 10,000 labels and 200 UTF-16 code units per label.

SHA-256 is taken over UTF-8 restricted RFC 8785 canonical JSON: object keys sorted by UTF-16 code units, strings serialized as JSON, arrays preserve order, numbers are nonnegative safe integers. Booleans, null, floating point values and control characters are outside this schema. Ten golden vectors are independently generated and checked by `tools/reference.py`; Node and the browser use `packages/protocol/index.ts`.

## Chain commitment

Temporary metadata label **674** contains `protocol`, `drawId`, `bundleHash`, `chainHash`, and `round`. No CIP-10 registration or interoperability claim is made. The browser builds a self-transfer, shows its estimated fee, then asks the selected CIP-30 wallet to sign and submit to preprod. It requests no private keys. Mainnet is rejected; preprod UTxOs are checked against the preprod indexer before building.

The verifier reads transaction metadata and inclusion time from Koios, verifies the organizer address was an input, and queries the historical block at inclusion height + 14. Both inclusion and that confirmation block must precede the selected round. It does not substitute the verifier's current time for the historical confirmation time. An unavailable or incomplete indexer response fails verification. The CLI accepts an alternative HTTPS Koios-compatible endpoint through `--indexer`.

Same-address/same-drawId history is paginated, up to 5,000 transactions. Exceeding this limit fails verification. The earliest inclusion height wins; multiple matching commitments in the same earliest block are rejected because this development implementation does not obtain authoritative intra-block ordering. Later commitments fail verification. Cross-address or different-drawId commitments cannot be ruled out. A published link is an announcement, not proof that publication occurred before the round.

## Randomness and selection

The address history filters commitments by actual transaction inputs, so incoming transfers cannot impersonate the organizer. Candidate ordering needs only inclusion evidence; a later commitment still awaiting confirmations cannot invalidate an earlier completed draw.

Quicknet chain hash: `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`. Genesis: 1692803367 Unix seconds. Period: 3 seconds. Round time = genesis + (round − 1) × period. The public key is pinned in `packages/beacon/index.ts` from the [official quicknet announcement](https://docs.drand.love/blog/2023/10/16/quicknet-is-live/).

Verify the unchained BLS signature over SHA-256 of the round encoded as an unsigned 64-bit big-endian integer, using the short G1 signature and the RFC 9380 `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` domain. Reject point-at-infinity signatures. Require `randomness = SHA-256(signature bytes)`. The recorded fixture is quicknet round 1,000,000, used only for the demo. Relays are tried sequentially and each response is cryptographically verified against the pinned key.

Seed = SHA-256(randomness bytes || bundle-hash bytes). Each participant's score = SHA-256(seed bytes || UTF-8 label). Sort scores ascending, breaking equal scores by original list index, and take the requested number of distinct labels. The downloaded result contains the complete bundle, commitment reference, beacon and declared winners; the verifier recomputes every winner rather than trusting the declaration.

## Sharing and verdicts

Small announcements and results use URL fragments, with a 12,000-character payload threshold. Larger results can be downloaded and hosted by the organizer; a URL query can pin the complete file's SHA-256 hash. Hosted files require browser CORS access. Public verification may expose public labels; contact information is never included by the importer.

`PASS` requires preprod evidence from the selected indexer. `DEMO PASS` uses simulated chain evidence and a real recorded drand signature. `FAIL` means at least one check failed or evidence was unavailable. Demo evidence must never be presented as Cardano evidence.

Verification covers selection from the committed list. It does not establish entrant eligibility, list completeness or prize delivery.

## Design review disposition

| Retained mechanism | Original constraint | Current evidence / industry alternative | Decision and re-evaluation trigger |
|---|---|---|---|
| One ADA-only input ≥ 5 test ADA; 2 ADA self-transfer | Spike A controlled transaction-size and fee measurements | Live preprod parameters and network checks remain required. General coin selection is described in Cardano CIP-2 and supported by Mesh `selectUtxosFrom`; multi-asset change has not undergone this project's real-wallet acceptance. | Keep as an explicit development support limit. During deferred preprod acceptance, validate multi-input/multi-asset change before extending support; do not claim this limit is a Cardano protocol requirement. |

Independent design review: one A finding recorded with a concrete trigger; no B or C findings. Scope covered identifiers, dependencies, metadata, canonicalization, BLS, time evidence, uniqueness, external queries, sharing, demo boundaries and static serving.
