# Browser-runner architecture

## TL;DR

- `perfeng-playwright` is a feature-oriented modular monolith with a functional core and a small
  imperative shell.
- The package API and two executables are explicit boundaries; exported declarations inside feature
  folders remain implementation details unless a public entry point exposes them.
- Entry points compose workflows, workflows own lifecycle, feature modules implement one browser or
  protocol responsibility, and adapters isolate Playwright, CDP, HTTP, Git and filesystem effects.
- The structure is sound for one versioned runner distribution. Splitting packages or adding a
  dependency-injection framework would increase coordination without improving an existing boundary.
- Native Worker one-shot execution has one explicit lifecycle coordinator; an unattended worker
  loop and automatic restart recovery remain outside this boundary.

## Architectural style

The repository uses a feature-oriented modular-monolith architecture. Browser measurement,
diagnostic capture and Native Worker protocol support change at different rates but are released as
one runner, use one toolchain and share exact artifact contracts. Keeping them in one package makes
those invariants testable without network or package-version coordination.

Within a feature, prefer a functional core surrounded by an imperative shell:

- parsing, validation, state projection and manifest construction are deterministic functions;
- browser, CDP, HTTP, Git and filesystem operations are explicit boundary adapters;
- orchestration owns resource lifetime, cancellation, retries and cleanup;
- entry points translate process input and compose application workflows.

Ports are useful where tests or policy need to substitute a real external effect. Existing function
parameters such as `fetch`, Git execution, clocks and waits are sufficient ports; a container or
framework-wide service abstraction is not required.

## Dependency direction

Dependencies point inward from entry points to workflows and responsibility-focused modules:

```text
src/index.ts              src/cli.ts              src/worker-cli.ts
     |                         |                         |
     v                         v                         v
public feature API       journey workflow        Native Worker lifecycle
     |                         |                         |
     +-------------------------+-------------------------+
                               |
                               v
 interaction | configuration | observation | trace | memory | smoothness
                               |
                               v
                  Playwright | CDP | HTTP | Git | filesystem
```

Implementation modules MUST NOT import root compatibility façades or executable entry points. A
feature MAY depend on another feature's domain types or focused operation when the dependency is
directional and the lifecycle owner remains clear. New circular feature dependencies are prohibited.
The existing `journey`/`observation` type-level cycle is an explicit transitional exception: journey
coordinates evidence capture, while observation currently imports journey's artifact descriptor.
The architecture gate permits only that exact cycle and requires removal of the exception when the
shared evidence type gains a neutral owner.

## Boundaries and ownership

| Boundary                                                       | Responsibility                                                                   | Does not own                                    |
| :------------------------------------------------------------- | :------------------------------------------------------------------------------- | :---------------------------------------------- |
| `src/index.ts`                                                 | Supported library exports and declaration surface                                | Process arguments or worker scheduling          |
| `src/cli.ts`                                                   | One configured journey and immutable local publication                           | Upload, registration or verdicts                |
| `src/worker-cli.ts`                                            | Native Worker process configuration, credentials, signals and presence lifecycle | Browser measurement semantics                   |
| `src/interaction`                                              | Semantic start/completion and raw named durations                                | Repetition or browser lifetime                  |
| `src/journey`                                                  | Repetition, browser lifecycle, capture selection and local artifacts             | Workload-specific user behavior                 |
| `src/journeys`                                                 | Repository-owned user journeys                                                   | Generic lifecycle policy                        |
| `src/observation`, `src/trace`, `src/memory`, `src/smoothness` | Bounded raw diagnostic evidence                                                  | Diagnosis or performance verdicts               |
| `src/native-worker`                                            | Lease-fenced protocol operations and exact artifact publication                  | Environment provisioning or control-plane state |
| `src/filesystem`                                               | Atomic, exclusive local publication and receipt-last commitment                  | Payload meaning, upload or durable storage      |

The root compatibility façades exist for current consumers. New implementation code imports the
owning feature module directly. The package exposes only `src/index.ts`; an `export` inside a feature
folder provides TypeScript module visibility for composition and tests, not a supported package API.

Journey and Native Worker publication share the filesystem adapter because atomic appearance and
no-overwrite recovery are storage-boundary concerns, not browser or protocol semantics. It stages
complete sibling files and exposes them with no-replacement hard links. Multi-file journey payloads
appear before the receipt; consumers treat receipt presence as commitment and ignore payload-only
recovery state. Unsupported filesystems fail closed rather than weakening this invariant.

The public journey API intentionally accepts Playwright's `Page`. The runner already defines
Playwright-specific execution and measurement semantics, so hiding `Page` behind a local duplicate
would weaken type information without creating portability.

## Lifecycle and state

Resource-owning orchestration makes transitions explicit and cleans up on success, failure,
cancellation and timeout. The generic journey lifecycle is:

```text
validated configuration -> browser -> context -> page -> warm-up -> measurement -> artifact write
```

The Native Worker protocol models presence, acquisition, renewal, artifact publication, terminal
reporting and release as focused operations. An internal supervisor maintains v2 lease authority
and forward phases around one abort-aware operation. The v2 attempt coordinator composes local
execution, publication and terminal reporting within that boundary. It also releases stopped
cancellation and shutdown attempts while authority remains proven. `run-once` adds an empty-spool
gate, local owner marker and one immediate acquisition window. A read-only spool inventory exposes
retained paths for operator review but does not recover server authority. Unattended acquisition
and automatic restart recovery remain absent.
The complete worker loop should use an explicit transition model:

```text
unavailable -> qualified -> acquiring -> preparing -> running -> uploading -> finalizing -> terminal
                                  |            |          |            |
                                  +------------+----------+------------+-> release/failure
```

Only the attempt coordinator may advance execution phases. Lease authority and capability material remain
encapsulated, cancellation is checked at every boundary, and terminal or release outcomes end the
attempt. Protocol modules must not grow independent background loops that compete for that state.

## Documentation boundary

TSDoc is part of the compatibility review for declarations exposed by `src/index.ts`, `src/cli.ts`
and `src/worker-cli.ts`. Comments live at the declaration that owns the contract so generated
declarations retain them. TypeDoc validates this surface without generating committed documentation.

Implementation helpers need comments only when timing, lifecycle, ownership, security,
serialization, resource limits or a non-obvious decision cannot be expressed clearly by the code.
This keeps architectural documentation fail-closed without turning internal syntax into prose.

## Architecture assessment

The current structure follows the selected architecture:

- feature directories are cohesive and root façades remain thin;
- orchestration and boundary effects are separated from validation and payload construction;
- browser and CDP resource owners perform bounded cleanup;
- Native Worker capability objects preserve lease authority instead of passing secrets as ordinary
  domain data;
- the known `journey`/`observation` type cycle is isolated as transitional debt rather than treated
  as an approved dependency direction.

Two constraints should guide the next implementation steps:

- define authoritative restart recovery before enabling unattended Native Worker availability;
- split `src/native-worker/types.ts` by protocol responsibility only when the coordinator makes
  ownership clearer, not merely to reduce file length.

Reconsider a package or process split only if a boundary gains an independent release cadence,
runtime, privilege model or deployment owner. File size alone is not sufficient evidence.
