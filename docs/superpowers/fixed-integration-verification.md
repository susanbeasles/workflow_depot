# Implementation verification — 2026-10-12

Implemented in isolated worktrees on `feat/fixed-integration-signing`; original worktrees and main were not changed.

## Verified behavior

- Fixed `int/<working-branch>` ref and immutable generation identity; old generations cannot qualify at reused names.
- Replacement closes the recorded PR, conditionally deletes its exact tip, creates the same ref and opens a new PR.
- Single-parent signed candidate above current main; zero-diff source does not produce an empty candidate.
- Source/main metadata reconciliation, authenticated event routing, durable operation IDs and retirement.
- All eight validation callers use only `int/**` pushes, admit current candidates before checks, and check out exact `github.sha`.
- Main transport verifies the one-parent relation and accepted tree before an expected-main conditional Git push. Temporary Git tests cover concurrent main and stale deletion.

## Fresh verification

- repoctl: `node --test controller/test/*.test.mjs` — 193 passed.
- delivery_control: `node --test test/*.test.*` — 76 passed.
- workflow_depot: `node --test test/*.test.mjs` — 154 passed.
- signing_control: `npm test` — 103 passed.
- After refreshing the immutable admission pin, workflow and orchestration focused tests passed again.
- Parsed all eight caller YAML files and verified triggers, admission dependencies and exact checkout.
- `git diff --check` passed in all eight source trees. Embedded delivery files match standalone files.
- Cross-component fixture exercises source changes, main changes, ref replacement, exact candidate evidence and promotion invalidation. Real Git transport tests independently exercise main advancement.

Only workflows changed in the four application repositories; their application suites were not rerun. Review was inline, with no subagents or independent reviewer. The full provider crash/recovery matrix and live provider rules have not been qualified; local tests must not be treated as production certification.

## Activation blockers

No automation was deployed or enabled. `signing_control` has no remote. Commissioning still requires source-PR-scoped accepted policy (including integrationIntent), trusted read credentials and signer/publisher service bindings, webhook installation, the candidate-admission endpoint, and provider protection qualification. Existing configuration remains disabled and fails closed when bindings are unavailable. External GitHub checks/rules could not be qualified with the available API access.

No live signing, credentials enrollment, key recovery, protection changes, or main promotion was performed.
