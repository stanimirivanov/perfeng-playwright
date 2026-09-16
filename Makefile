.PHONY: help fmt fmt-check check test build validate

help:
	@echo perfeng-playwright engineering command surface
	@echo "  make fmt        Format repository-owned source and documentation"
	@echo "  make fmt-check  Verify formatting without changing files"
	@echo "  make check      Run formatting, linting and strict type checks"
	@echo "  make test       Run Playwright browser tests"
	@echo "  make build      Build the distributable library and CLI"
	@echo "  make validate   Run all repository validation"

fmt:
	pnpm format

fmt-check:
	pnpm format:check

check: fmt-check
	pnpm lint
	pnpm typecheck

test:
	pnpm test

build:
	pnpm build

validate: check build test
