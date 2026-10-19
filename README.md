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

Verify a downloaded result with:

```sh
node apps/verifier-cli/index.mjs draw-example.json --indexer https://your-node.example/api/v0
```

The CLI returns exit code 0 for PASS / DEMO PASS and 1 for FAIL; without `--indexer` it exits with code 2. There is no project default: `--indexer` names a Blockfrost-compatible indexer you trust, such as your own [Dolos](https://github.com/txpipe/dolos). It must be a full archive, its account address list must include addresses whose funds are already spent, and its `max_scan_items` must be at least 3000 (the Dolos default); plain `http` is accepted only for a node on the same machine. A demo result does not read the indexer. Browser access to organizer-hosted bundles requires CORS; share links pin the hosted file hash.

The convenience backend in `apps/api/` is a local walking skeleton: `make api` starts it with Wrangler on `http://127.0.0.1:8787`, where `/tip` forwards the indexer's read-only `/blocks/latest` (`INDEXER_URL` in `apps/api/wrangler.jsonc`) and nothing else. In preprod mode the page shows that tip. The page reads the backend address from `GIVEAWAY_API_URL` and the project indexer from `GIVEAWAY_INDEXER_URL` at build time (defaults `http://127.0.0.1:8787` and `http://127.0.0.1:3010`, the local Dolos development chain in `tools/devchain/`). The verification page can use another Blockfrost-compatible indexer instead. Verification does not use the backend, and the CLI still queries the indexer directly. The backend is not deployed.

`make check` runs Biome lint and formatting checks, TypeScript checking, Node tests, the backend tests inside the local Workers runtime, ten independent Python golden vectors and plan consistency checks. The optional browser end-to-end check uses an existing Playwright installation and Chrome, without downloading browsers or using personal profiles:

```sh
GIVEAWAY_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs \
GIVEAWAY_CHROME_PATH=/path/to/chrome \
node tools/browser-check.mjs
```

See [development protocol](docs/protocol-development.md) for exact formats, algorithms, query limits and verification boundaries. Small result bundles fit in fragment links; larger bundles must be downloaded and publicly hosted by the organizer. Reloading the creation page clears the in-memory draft.

## License

MIT; see [LICENSE](LICENSE).

## References

- https://docs.drand.love/blog/2023/06/02/drand-explainer/
- https://proofdraw.com/
