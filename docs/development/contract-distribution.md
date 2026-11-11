# Updating and restoring Playwright contracts

Prepare Native Worker fixtures from the pinned signed distribution. The
[shadow setup](../../README.md#shadow-the-native-worker-contract-distribution)
describes the retained assets and independently qualified verifier. Use a fresh
staging directory under an operator-owned parent.

```sh
CONTRACTS_SHADOW_ASSETS="$assets" CONTRACTS_BOOTSTRAP_ROOT="$bootstrap" \
  CONTRACTS_VERIFIER="$verifier" make contracts-update-check CONTRACTS_STAGING_TARGET="$staging"
```

Review the staged ledger and fixtures before applying them to
`vendor/contracts` in a build checkout. The gate checks the reviewed OpenAPI
digest without adding the API document to the package. An invalid or unavailable
signed input stops preparation. The Native Worker bundle remains 0.27.0 and the
raw-result wire contract remains 0.19.0. A revision change needs a separate
reviewed selection and compatibility check.

Before cutover, retain the previous package, its reviewed SHA-256, and its
source revision. Build and pack the candidate from the staged snapshot. Run the
package gate from the candidate checkout after building its local `dist`:

```sh
make contracts-package-check CONTRACTS_CURRENT_PACKAGE="$candidate" \
  CONTRACTS_ROLLBACK_PACKAGE="$retained" CONTRACTS_ROLLBACK_SHA256="$retained_sha256"
```

The gate installs both packages independently outside the source checkout with
offline resolution and lifecycle scripts disabled. It checks the fixture and
compiled runtime inventories, including the raw-result writer, and exercises
the installed Native Worker recipe parser. The rehearsal covers distribution
rollback at the same contract revisions.
