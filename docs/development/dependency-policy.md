# Dependency policy

## TL;DR

- Use Node.js and pnpm versions declared by the repository and the exact `pnpm-lock.yaml`.
- Add dependencies only for current runner or verification behavior after maintenance, license, security, browser, and replacement review.
- Audit the complete graph because the private distributable currently uses Playwright from its development dependency set.
- GitHub Actions use semantic major references; vendored contract checksums and source provenance remain exact.
- Browser and dependency upgrades are environment changes and stay separate from performance conclusions.

## Dependency admission

Prefer platform APIs and current dependencies when they express the boundary clearly. A new package requires an owned use case, compatible license, maintained releases, acceptable transitive graph, and a proportionate replacement seam. Exact versions and the lockfile are authoritative.

The package is private, but its compiled runner imports Playwright at runtime. Supply-chain checks therefore inspect all dependencies rather than using a production-only filter that would omit relevant code. Reclassifying package dependencies or changing distribution is a separate packaging decision.

## Updates and browser identity

Dependency, Node, pnpm, Playwright, or Chromium changes receive focused release-note and compatibility review. A browser/runtime update can change the measurement environment and requires the environment and baseline-policy consideration described in the engineering standards.

Workflow `uses:` entries use semantic majors such as `actions/checkout@v7`. Vendored contract locks, evidence checksums, source revisions, and captured provenance are immutable identities and are not converted to floating references.

## Supply-chain response

`make supply-chain` verifies the frozen lock and audits known vulnerabilities.
Dependabot proposes GitHub Actions updates only. pnpm 11 dependency updates
remain a manual, lockfile-aware workflow until the hosted updater supports that
package-manager major. All proposals are ordinary reviewed changes. Exceptions
identify exact packages, risk, owner, expiry, and compensating evidence;
unavailable advisory data is reported as not run.
