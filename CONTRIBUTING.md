# Contributing

Keep changes inside the browser-runner boundary. Do not add control-plane,
storage, normalization, policy, or regression decisions to this repository.

Run `pnpm validate` before submitting a change. Dependencies and browser
versions must stay exact and the lockfile must be committed. Update them in an
explicit pull request so browser changes cannot be mistaken for application
performance changes.

Use browser-side timing for measured intervals. Controller-side timestamps may
be used for diagnostics, never as the authoritative interaction duration.
Define semantic completion explicitly and keep cold and warm samples in
separate profiles. Keep baseline timings separate from diagnostic runs, and do
not claim a diagnostic mode until its evidence collector is implemented. Tests
must use systems the contributor owns or is authorized to exercise.

Comments should explain contracts and non-obvious invariants. Do not add lint
suppression comments or comments that merely restate the code.
