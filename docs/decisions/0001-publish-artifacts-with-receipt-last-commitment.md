# ADR-0001: Publish artifacts with receipt-last commitment

- Status: Accepted
- Date: 2026-09-29
- Milestone: M03 — Native Browser Decision Loop
- Deciders: Project owner
- Supersedes:
- Superseded by:

## TL;DR

- Stage and flush complete bytes beside each destination before exposing a final path.
- Use a same-directory hard link for atomic, no-replacement publication.
- Publish payloads first and the integrity receipt last; receipt presence commits the set.
- Reuse only exact recovery files and never delete a final path during cleanup.
- Fail closed when the filesystem cannot provide the required hard-link behavior.

## Context

Opening a final destination exclusively and then writing into it prevents replacement, but readers
and process failure can observe or leave a partial final file. A multi-file journey also needs an
unambiguous indication that every referenced payload is complete. Node does not provide one atomic
transaction across arbitrary filesystem paths.

Journey output and the Native Worker raw-result manifest use the same local safety requirements.
The implementation needs one filesystem boundary that works on the intended Windows NTFS worker
and Linux development and CI filesystems without weakening no-overwrite behavior.

## Decision

The runner writes each file into a uniquely owned temporary directory beneath the destination's
parent, flushes and closes it, and then creates the final name with a hard link. Creating the link
atomically exposes complete bytes and fails if the destination already exists.

For a journey bundle, all missing files are staged before publication. Payload links are created
before the receipt link. The receipt is the commit marker: consumers must not treat payload-only
files as a completed bundle. Retry may reuse regular, non-symlink files only after exact byte
verification. An existing exact receipt is accepted only when the full referenced set is exact.

Cleanup removes only the invocation's staging paths. It never removes a final path, including after
a late failure, because another publisher may already rely on exact bytes at that name.

## Alternatives considered

### Write directly through an exclusive final handle

- Benefits: Simple and supported on all Node filesystems.
- Costs and risks: Exposes partial bytes and leaves a blocking partial file after process failure.
- Reason not selected: It does not meet atomic-visibility requirements.

### Rename or exclusive copy

- Benefits: Familiar temporary-file workflow.
- Costs and risks: Rename may replace an existing destination, while an exclusive copy is not an
  atomic publication primitive.
- Reason not selected: Neither operation provides both atomic appearance and no replacement.

### Roll back already published final paths

- Benefits: Leaves fewer payload-only files after an ordinary error.
- Costs and risks: A pathname may have been adopted by an identical concurrent publisher; deleting
  it can corrupt a successfully committed set.
- Reason not selected: Complete uncommitted payloads are safer recovery state than path deletion.

## Consequences

### Positive

- Readers never observe a partially written final file.
- Existing evidence is not overwritten or deleted.
- Receipt presence gives consumers an explicit multi-file commitment rule.
- Exact retries can finish an interrupted publication without rewriting evidence.

### Negative

- Publication requires same-directory hard-link support.
- Payload-only recovery files can remain when publication stops before the receipt.
- Process termination can leave hidden staging directories that require ownership-safe operator
  cleanup; retries deliberately do not delete unknown staging state.
- File flush plus hard-link publication does not claim universal power-loss durability.
- A process that retains write access can mutate an inode after verification; consumers still
  verify receipt checksums before accepting evidence.

### Neutral or follow-up

- Native Windows and Linux validation must retain coverage of hard-link and collision behavior.
- Operators may need to remove uncommitted mismatched outputs before intentionally reusing paths.

## Compatibility and migration

Artifact bytes, schemas, integrity values and public function signatures do not change. Exact
journey-bundle and Native Worker manifest retries become idempotent. Mismatched, non-regular and
symlink destinations continue to fail without replacement.

## Security and operations

Temporary directories use unpredictable invocation-owned names. Existing symlinks and non-regular
files are rejected. No fallback may trade away atomic or exclusive behavior. Payload-only files are
sensitive evidence and retain the same handling requirements as committed artifacts. Operators may
remove an orphan staging directory only after establishing that no publisher still owns it; the
runner never scans or deletes unknown staging names automatically. Publication narrows concurrent
path changes with handle and identity checks but cannot prevent an uncooperative writer from
modifying a final inode later; consumers must verify the committed checksums.

## Measurement and environment limitations

The decision changes publication only. Browser timing, capture lifecycle, environment identity and
diagnostic meaning are unchanged. Linux CI verifies correctness but does not establish Windows
performance comparability.

## Validation

Tests verify atomic visibility, receipt-last order, exact recovery, late collisions, concurrent
publishers, preservation of foreign paths, staging cleanup and fail-closed hard-link errors on the
supported operating systems.
