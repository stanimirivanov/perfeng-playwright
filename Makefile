.PHONY: help bootstrap doctor fmt fmt-check docs-check architecture-check check test build verify supply-chain validate

help:
	@echo perfeng-playwright engineering command surface
	@echo "  make bootstrap  Install the frozen dependency graph and Chromium"
	@echo "  make doctor     Report the effective engineering toolchain"
	@echo "  make fmt        Format repository-owned source and documentation"
	@echo "  make fmt-check  Verify formatting without changing files"
	@echo "  make docs-check Verify TSDoc, documentation links and repository policy"
	@echo "  make architecture-check  Verify documented production import boundaries"
	@echo "  make check      Run formatting, linting, documentation and strict type checks"
	@echo "  make test       Run Playwright browser tests"
	@echo "  make build      Build the distributable library and CLI"
	@echo "  make verify     Run the network-independent inner loop"
	@echo "  make supply-chain  Audit the complete dependency graph"
	@echo "  make validate   Run complete repository acceptance"

bootstrap:
	pnpm install --frozen-lockfile
	pnpm exec playwright install chromium

doctor:
	@git --version
	@node --version
	@pnpm --version
	@pnpm exec playwright --version
	@$(MAKE) --version

fmt:
	pnpm format

fmt-check:
	pnpm format:check

docs-check:
	pnpm docs:check
	pnpm repo:check

architecture-check:
	pnpm architecture:check

check: fmt-check docs-check architecture-check
	pnpm lint
	pnpm typecheck

test:
	pnpm test

build:
	pnpm build

verify: check build test

supply-chain:
	pnpm audit --audit-level high

validate: verify supply-chain
