## Linked work

- Issue:
- Milestone: MNN — Outcome

## Outcome and scope

Problem and resulting behavior:

Boundaries and deliberate exclusions:

Assumptions and unresolved questions:

## Design, compatibility and operations

- ADRs:
- Semantic timing and lifecycle effects:
- Environment identity and comparability effects:
- Diagnostic evidence and sensitivity effects:
- Artifact, CLI and package compatibility effects:
- Target authorization and security effects:
- Rollout, recovery and rollback:
- Externally visible or destructive actions authorized by:

## Verification

- [ ] Prettier format check
- [ ] ESLint
- [ ] Strict TypeScript compilation
- [ ] Distributable package build
- [ ] Playwright browser tests
- [ ] Native Windows worker checks where applicable

Commands and non-secret evidence:

Checks not run, blocking reason and residual risk:

## Limitations and review

- [ ] One coherent, independently mergeable outcome
- [ ] Semantic start/completion and browser-clock timing remain explicit
- [ ] Cold/warm lifecycle and environment identity retain their meaning
- [ ] Measurements, diagnostics, artifacts and verdicts remain separate
- [ ] Relevant invalid, timeout and partial-evidence behavior is tested
- [ ] No lint-suppression comments added merely to silence findings
- [ ] No secrets, captured evidence, external targets, machine-specific paths or unrelated churn
- [ ] No unapproved external execution, publication or destructive side effects

Known limitations and follow-up:
