.PHONY: check build lint typecheck test dev
build:
	node tools/build.mjs
typecheck:
	pnpm exec tsc --project packages/tsconfig.json
	pnpm exec tsc --project apps/web/tsconfig.json
	pnpm exec tsc --project apps/verifier-cli/tsconfig.json
lint:
	pnpm exec biome check --error-on-warnings
test: build
	node --test tests/*.test.mjs
check: lint typecheck test
	node tools/mutation-check.mjs
	python3 tools/reference.py --check
	python3 docs/plans/2026-10-01-verifiable-giveaway-mvp/check_plan.py
dev: build
	node tools/serve.mjs
