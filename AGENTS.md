# Project instructions

## Purpose and scope

Help community organizers run free giveaways whose committed entrant list, rules and selection algorithm can be independently checked.

- Read README.md for the planned experience and verification boundaries.
- The product is exploratory. Use TypeScript, the static web application and the independent Node verifier; development protocol defaults remain unfrozen until preprod acceptance.
- A TypeScript convenience backend (indexer proxy, bundle hosting, drafts) is decided; `apps/api/` holds only a local walking skeleton whose `/tip` proxies the project indexer's `/blocks/latest`, and it is not deployed. It never signs or submits transactions, generates randomness or decides PASS/FAIL, and the verifier never depends on it (`docs/adr/2026-10-18-typescript-convenience-backend.md`).
- Do not present planned functionality as implemented, deployed or validated by users.
- Keep payments, revenue splitting, bookings, token issuance, NFTs, betting and cryptocurrency prizes outside the product core.
- Distinguish blockchain commitments and validator checks from claims about external facts.
- Run `make check` before reporting implementation completion. Browser checks use existing Playwright and Chrome installations through explicit environment variables; do not read personal browser profiles or request private keys.
- Decision records (ADR) live in `docs/adr/`.

## Project-specific boundary

Verification covers selection from the committed list. It does not establish entrant eligibility, list completeness or prize delivery.
