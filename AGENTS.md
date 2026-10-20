# Project instructions

## Purpose and scope

Help community organizers run free giveaways whose committed entrant list, rules and selection algorithm can be independently checked.

- Read README.md for the planned experience and verification boundaries.
- The product is exploratory. Use TypeScript for the web page (static files built from `apps/web/`), the convenience backend (`apps/api/`) and the independent Node verifier; development protocol defaults remain unfrozen until preprod acceptance.
- Chain data comes from a Blockfrost-compatible indexer. The project indexer is its own full-archive Dolos on a VM (not deployed), which the page reads directly through the reverse proxy in `deploy/dolos-proxy/` (no Workers proxy); the CLI has no default indexer and must be given `--indexer` (`docs/adr/2026-10-19-self-hosted-dolos-indexer.md`).
- The convenience backend `apps/api/` (Cloudflare Workers, D1, R2) runs locally and is not deployed: owner-signed bundle hosting with bounded retention, owner deletion and extension, signed server drafts, and the operator takedown in `docs/runbooks/takedown.md`. It never forwards indexer requests, signs or submits transactions (the wallet submits with CIP-30 `submitTx`), generates randomness or decides PASS/FAIL, and the verifier never depends on it (`docs/adr/2026-10-18-typescript-convenience-backend.md`).
- The privacy notice is `apps/web/privacy.html`; change it together with anything the backend or the proxy stores, or how long. Reports and takedown requests go to GitHub issues, or to a private security advisory when they need personal data.
- Do not present planned functionality as implemented, deployed or validated by users.
- Keep payments, revenue splitting, bookings, token issuance, NFTs, betting and cryptocurrency prizes outside the product core.
- Distinguish blockchain commitments and validator checks from claims about external facts.
- Run `make check` before reporting implementation completion. Browser checks use existing Playwright and Chrome installations through explicit environment variables; do not read personal browser profiles or request private keys.
- Decision records (ADR) live in `docs/adr/`.

## Project-specific boundary

Verification covers selection from the committed list. It does not establish entrant eligibility, list completeness or prize delivery.
