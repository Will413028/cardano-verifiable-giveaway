# Development protocol

This is an implementation default, not frozen protocol v1. The metadata/quicknet/SHA-256 ranking/15-confirmation/NFC defaults will be finalized after the deferred preprod experiments. The runnable demo is not an on-chain giveaway.

## Bundle and canonical commitment

`version: development-2`, `algorithm: sha256-ranking-1`, `drawId`, `entrants`, `rules: { winners }`, and `drand: { chainHash, round }` are the only bundle fields. Labels must be trimmed NFC strings, unique, and free of control characters or lone surrogates. CSV imports use only the `label` column and discard contact columns. Email and phone-shaped labels are rejected. The development limits are 10,000 labels and 200 UTF-16 code units per label. From these, the canonical bundle is at most `BUNDLE_BYTE_LIMIT` = 10,000 × (200 × 3 + 3) + 512 = 6,030,512 bytes: in the worst case every code unit is a BMP character taking three UTF-8 bytes, each label adds two quotes and a comma, and the remaining fields fit in 512 bytes. A downloaded proof may also list every label as a winner and is pretty-printed, so files read by the web page and the CLI are limited to `ARTIFACT_BYTE_LIMIT` = `BUNDLE_BYTE_LIMIT` + 10,000 × 603 + 2 × 10,000 × 8 + 4,096 = 12,224,608 bytes. Both constants live in `packages/protocol/index.ts` and are shared by every reader.

SHA-256 is taken over UTF-8 restricted RFC 8785 canonical JSON: object keys sorted by UTF-16 code units, strings serialized as JSON, arrays preserve order, numbers are nonnegative safe integers. Booleans, null, floating point values and control characters are outside this schema. Ten golden vectors are independently generated and checked by `tools/reference.py`; Node and the browser use `packages/protocol/index.ts`.

## Chain commitment

Development metadata label **20261018** contains `protocol`, `drawId`, `bundleHash`, `chainHash`, and `round`. The number was absent from the [CIP-10 registry](https://github.com/cardano-foundation/CIPs/blob/master/CIP-0010/registry.json) when checked on 2026-10-18 (CIPs commit `befcdb7`); it is not registered, and registration is left to the v1 freeze. `development-1` used 674, which CIP-10 assigns to CIP-20 transaction messages; commitments under 674 are not supported. The browser builds a self-transfer, shows its estimated fee, then asks the selected CIP-30 wallet to sign and submit to preprod. It requests no private keys. Mainnet is rejected; preprod UTxOs are checked against the preprod indexer before building.

The verifier reads transaction metadata and inclusion time from Koios, verifies the organizer address was an input, and queries the historical block at inclusion height + 14. Both inclusion and that confirmation block must precede the selected round. It does not substitute the verifier's current time for the historical confirmation time. An unavailable or incomplete indexer response fails verification. The CLI accepts an alternative HTTPS Koios-compatible endpoint through `--indexer`.

### Uniqueness

Uniqueness is decided per organizer identity, not per address and drawId (ADR `docs/adr/2026-10-18-uniqueness-by-interval-overlap.md`). The identity of the organizer address is its stake credential when the address has a stake part, otherwise its payment credential; only key-hash base and enterprise preprod addresses are accepted. The verifier lists the identity's whole history from Koios (`account_txs` by stake address, `credential_txs` by payment credential), ordered by block height then transaction hash, in pages of 1,000 up to 5,000 transactions; exceeding this limit fails verification. Metadata is then read in batches of 50 transaction hashes, because the Koios public tier rejects request bodies over 5 KiB.

Each commitment is open from its inclusion until its round. Two commitments of the same identity whose intervals [inclusion, round) overlap both fail, whatever their drawId or round, and the verdict lists the conflicting commitments (`conflicts`, and the detail of the `Unique commitment` check). Two commitments in the same block always overlap, so simultaneous commitments fail closed without needing intra-block ordering. A commitment included at or after its own round fails the timing check and blocks nothing, so a commitment sent after a completed draw cannot invalidate it; consecutive draws whose intervals do not overlap both pass. If the referenced commitment is missing from the enumerated history, uniqueness fails. The history needs only inclusion evidence: a later commitment still awaiting confirmations is compared by its inclusion time and round, without waiting for its confirmations.

Which transactions count as the identity's commitments: in this development implementation a transaction counts only when it spends from the organizer address itself, so the ledger has required the organizer's payment key signature. Incoming transfers and a third party's address that reuses the organizer's stake part (CIP-19 allows this) therefore cannot create or invalidate a commitment. The cost is that the same wallet can commit from another of its payment addresses without the conflict being seen. Checking the identity key in `required_signers` and its witness from the transaction CBOR, which closes that gap, is planned (hardening plan step 7) and not implemented.

Commitments from another wallet cannot be ruled out. A published link is an announcement, not proof that publication occurred before the round.

## Randomness and selection

Quicknet chain hash: `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`. Genesis: 1692803367 Unix seconds. Period: 3 seconds. Round time = genesis + (round − 1) × period. The public key is pinned in `packages/beacon/index.ts` from the [official quicknet announcement](https://docs.drand.love/blog/2023/10/16/quicknet-is-live/).

Verify the unchained BLS signature over SHA-256 of the round encoded as an unsigned 64-bit big-endian integer, using the short G1 signature and the RFC 9380 `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_` domain. Reject point-at-infinity signatures. Require `randomness = SHA-256(signature bytes)`. The recorded fixture is quicknet round 1,000,000, used only for the demo. Relays are tried sequentially and each response is cryptographically verified against the pinned key.

Seed = SHA-256(randomness bytes || bundle-hash bytes). Each participant's score = SHA-256(seed bytes || UTF-8 label). Sort scores ascending, breaking equal scores by original list index, and take the requested number of distinct labels. The downloaded result (`giveaway-proof-2`) contains exactly `network`, the complete bundle, the commitment reference (`txHash` and `owner`), the beacon and the declared winners; the verifier reads inclusion, confirmation and history for that reference from the chain and recomputes every winner rather than trusting the declaration. Any other field is rejected. The pre-round announcement (`giveaway-pending-2`) contains exactly `network`, the bundle, `txHash` and `owner`.

## Sharing and verdicts

Small announcements and results use URL fragments, with a 12,000-character payload threshold. Larger results can be downloaded and hosted by the organizer; a URL query can pin the complete file's SHA-256 hash. Hosted files require browser CORS access. Public verification may expose public labels; contact information is never included by the importer.

Each check is `pass`, `fail` or `unevaluated`. When chain evidence cannot be read, the commitment hash, timing and unique-commitment checks are `unevaluated` rather than computed from the artifact; when the beacon does not verify, winner recomputation is `unevaluated`. A valid beacon signature for the committed round proves the round has been produced, so the verifier does not consult its local clock.

`PASS` requires every check to pass with preprod evidence from the selected indexer. `DEMO PASS` uses simulated chain evidence and a real recorded drand signature; the demo reference is `SHA-256("giveaway-demo-commitment:" || bundle hash)` with owner `demo-organizer`. This only catches a bundle changed without recomputing the reference: anyone can derive a matching demo reference for any bundle, so demo evidence binds nothing. `FAIL` means at least one check failed or was not evaluated. Demo evidence must never be presented as Cardano evidence.

Verification covers selection from the committed list. It does not establish entrant eligibility, list completeness or prize delivery.

## Design review disposition

| Retained mechanism | Original constraint | Current evidence / industry alternative | Decision and re-evaluation trigger |
|---|---|---|---|
| One ADA-only input ≥ 5 test ADA; 2 ADA self-transfer | Spike A controlled transaction-size and fee measurements | Live preprod parameters and network checks remain required. General coin selection is described in Cardano CIP-2 and supported by the Evolution SDK builder; the page re-reads the unsigned CBOR and refuses any input, output, body field or metadata outside this shape before `signTx`. Multi-asset change has not undergone this project's real-wallet acceptance. | Keep as an explicit development support limit. During deferred preprod acceptance, validate multi-input/multi-asset change before extending support; do not claim this limit is a Cardano protocol requirement. |

Independent design review: one A finding recorded with a concrete trigger; no B or C findings. Scope covered identifiers, dependencies, metadata, canonicalization, BLS, time evidence, uniqueness, external queries, sharing, demo boundaries and static serving.
