# Perfeng Playwright coding harness

## TL;DR

- Run `make bootstrap` once, `make verify` while editing, and `make validate` before handoff.
- `make architecture-check` enforces the import rules already documented by the architecture guide.
- Browser tests use loopback fixtures; Linux prove functional behavior, not comparable performance.
- Supply-chain checks are separate because advisory data may require network access.

## Verification tiers

| Tier                     | Command                 | Purpose and constraints                                                                             |
| :----------------------- | :---------------------- | :-------------------------------------------------------------------------------------------------- |
| Setup                    | `make bootstrap`        | Install the frozen pnpm graph and pinned Chromium build. Network may be required.                   |
| Inner loop               | `make verify`           | Run formatting, lint, types, documentation, import architecture, build, and loopback browser tests. |
| Supply chain             | `make supply-chain`     | Audit the complete dependency graph, including runtime-relevant development dependencies.           |
| Complete acceptance      | `make validate`         | Aggregate verification and supply-chain checks.                                                     |
| Native worker acceptance | Focused Linux execution | Prove platform-specific worker and filesystem behavior on an authorized declared worker.            |

The root Makefile and package scripts form one stable command surface. CI runs
functional checks on pinned Ubuntu 24.04 hosted images, and
retains browser failure evidence. These hosts do not establish performance
comparability with the declared native Linux reference worker. `make verify`
is network-independent after bootstrap and never contacts an external test
target.

## Architecture feedback

The import gate implements only documented invariants: production code cannot
import tests or examples, feature implementation cannot depend on executable
entry points or root compatibility facades, and production modules cannot form
file or unapproved feature cycles. Static and literal dynamic imports are both
checked. Focused directional feature dependencies remain allowed; the one
documented transitional `journey`/`observation` cycle is an exact exception
that becomes a failure once it is stale.

## Extending the harness

Prefer an existing linter, compiler, TypeDoc, or Playwright assertion when it can express the rule precisely. Add custom policy only for repository-specific structure not covered by those tools, and cover it with a failing fixture. A missing browser, network, or native Linux worker is reported as not run under CONTRIBUTING rather than hidden by a weaker substitute.
