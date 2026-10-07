# Perfeng Playwright documentation map

## TL;DR

- Start with [CONTRIBUTING.md](../CONTRIBUTING.md), then load only the guides relevant to the changed browser boundary.
- Measurement semantics, diagnostics, Native Worker protocol, immutable publication, and architecture have separate owners.
- Linux CI proves functional behavior; native Windows validation is required for Windows-specific filesystem and worker behavior, not as a performance baseline.
- Update this map whenever a canonical guide moves or a recurring task lacks a route.

## Route by task

| Task or changed area                      | Read first                                                                                                                                    | Verify or consult as needed                                  |
| :---------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| Contributor workflow or issue preparation | [Contributor guide](../CONTRIBUTING.md)                                                                                                       | [Working agreement](../AGENTS.md)                            |
| Build, CI, policy, dependency, or setup   | [Harness guide](development/harness.md), [dependency policy](development/dependency-policy.md)                                                | `make verify`, `make validate`                               |
| Module responsibility or import direction | [Architecture guide](development/architecture.md)                                                                                             | `make architecture-check`                                    |
| Semantic timing, lifecycle, or public API | [Engineering standards](development/engineering-standards.md), [repository README](../README.md)                                              | TypeDoc, browser fixtures, package build                     |
| Native Worker presence and protocol       | [Native worker presence](native-worker-presence.md)                                                                                           | Vendored contract lock and focused protocol tests            |
| Native Worker v2 local lifecycle          | [One-shot execution](native-worker-presence.md#execute-one-assigned-attempt), [architecture](development/architecture.md#lifecycle-and-state) | Reviewed v2 recipe, attempt and local artifact tests         |
| Immutable artifact publication            | [ADR-0001](decisions/0001-publish-artifacts-with-receipt-last-commitment.md)                                                                  | Filesystem collision and recovery tests on Linux and Windows |
| Durable decisions                         | [ADR index](decisions/README.md)                                                                                                              | Architecture and affected consumer documentation             |

## Keeping this map useful

This map routes readers and does not duplicate canonical policy. `make docs-check` validates local links and repository policy structure. Captured evidence, generated output, reports, and machine-local browser state do not belong in documentation or Git.
