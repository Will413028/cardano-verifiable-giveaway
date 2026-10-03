.PHONY: check build lint typecheck test dev
build:
	node tools/build.mjs
typecheck:
	pnpm exec tsc --project tsconfig.json
lint:
	node tools/lint.mjs
test: build
	node --test tests/*.test.mjs
check: lint typecheck test
	python3 tools/reference.py --check
	python3 docs/plans/2026-10-01-verifiable-giveaway-mvp/check_plan.py
dev: build
	node tools/serve.mjs
