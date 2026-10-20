# Cardano Verifiable Giveaway

Help community organizers run free giveaways whose committed entrant list, rules and selection algorithm can be independently checked.

## Status

Runnable local development preview: static web app, wallet-free demo, preprod transaction integration, public result verification and an independent CLI. No public deployment or real-wallet acceptance has been completed; user demand remains unvalidated. The metadata and selection protocol are development defaults, not frozen v1.

## Planned experience

1. Commit the entrant list, rules, algorithm version and a future drand round on Cardano.
2. Use that round's verifiable randomness after the commitment is confirmed.
3. Publish the necessary data and an independent result verifier.

## Scope

- Use Cardano to reduce dependence on a single operator and support independent verification.
- Payments, revenue splitting and bookings are outside the product scope.
- Token issuance, NFTs, betting and cryptocurrency prizes are not the product core.

## Verification boundaries

Verification covers selection from the committed list. It does not establish entrant eligibility, list completeness or prize delivery.

## Development

Requires Node 22+, pnpm 11 and Python 3. Install the locked dependencies, then:

```sh
pnpm install --frozen-lockfile
make check
make dev
```

Open `http://127.0.0.1:4320/`. Demo mode needs no wallet: preview → commit → simulate confirmations → reveal → download or share. A fresh verification page can check the shared result independently. The demo uses a real recorded quicknet BLS signature and simulated Cardano evidence, producing **DEMO PASS**.

Verify a downloaded result with either download: the proof, or the bundle file and the commitment transaction hash (the CLI then fetches the drand beacon and recomputes the winners itself):

```sh
node apps/verifier-cli/index.mjs example.proof.json --indexer https://your-node.example/api/v0
node apps/verifier-cli/index.mjs example.bundle.json --tx <commitment txHash> --indexer https://your-node.example/api/v0
```

The CLI returns exit code 0 for PASS / DEMO PASS and 1 for FAIL; without `--indexer` it exits with code 2. There is no project default: `--indexer` names a Blockfrost-compatible indexer you trust, such as your own [Dolos](https://github.com/txpipe/dolos). It must be a full archive, it must record 0 ADA reward withdrawals in `/accounts/{stake}/withdrawals` (Dolos 1.6.1 does; db-sync needs `ioShelley`) and honour `order=asc` there, and its `max_scan_items` must be at least 3000 (the Dolos default); plain `http` is accepted only for a node on the same machine. A demo result does not read the indexer. A verification link carries the commitment transaction hash and the bundle hash; the page fetches the bundle from the backend's hosted copy or from another HTTPS URL named in the link (which must allow CORS) and refuses bytes with another hash.

The page reads chain data directly from the project indexer, set at build time by `GIVEAWAY_INDEXER_URL` (default `http://127.0.0.1:3010`, the local Dolos development chain in `tools/devchain/`); in preprod mode it shows that indexer's tip, and the verification page names the indexer its evidence came from and can use another Blockfrost-compatible indexer instead. The selected CIP-30 wallet submits the signed commitment (`submitTx`); neither the page's indexer nor the backend handles transactions. A public deployment puts the reverse proxy in `deploy/dolos-proxy/` (read-only endpoint allowlist, per-IP rate limit, CORS origin list, no request content in logs; [runbook](docs/runbooks/dolos-proxy.md)) in front of Dolos. The convenience backend in `apps/api/` hosts bundles locally (`make api` starts it with Wrangler on `http://127.0.0.1:8787`, with local D1 and R2): it accepts only the bundle bytes of a confirmed on-chain commitment that pass the bundle checks, keeps them until 12 months after the earlier of the round and the commitment's first hosting (uploading again starts no new period), and at most 20 per organizer. Verification does not need it: a link can name another host, and the CLI queries the indexer it is given directly. Neither the backend nor the proxy is deployed.

`make check` runs Biome lint and formatting checks, TypeScript checking, Node tests, the backend tests inside the local Workers runtime, ten independent Python golden vectors and plan consistency checks. The optional browser end-to-end check uses an existing Playwright installation and Chrome, without downloading browsers or using personal profiles:

```sh
GIVEAWAY_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
GIVEAWAY_CHROME_PATH=/path/to/chrome \
node tools/browser-check.mjs
```

See [development protocol](docs/protocol-development.md) for exact formats, algorithms, query limits and verification boundaries. Small results also fit in fragment links; otherwise share the transaction-and-bundle-hash link of a hosted bundle. Reloading the creation page clears the in-memory draft.

## License

MIT; see [LICENSE](LICENSE).

## References

- https://docs.drand.love/blog/2023/06/02/drand-explainer/
- https://proofdraw.com/
