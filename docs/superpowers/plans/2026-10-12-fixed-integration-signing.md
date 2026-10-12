# Fixed-name integration signing implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline; do not spawn subagents.

**Goal:** Publish one signed squash commit above current main on the fixed
`int/<working-branch>` ref, validate only that candidate, and promote it without
rewriting any main commit.

**Architecture:** Retain the isolated signer and existing policy/publisher
boundaries. Introduce durable generation identity independent of ref names,
serialized reconciliation, conditional delete/create publication, integration-only
CI admission, and an exact-parent main advancement operation.

**Tech Stack:** Existing Node.js ESM modules, node:test, Git object/transport
commands, GitHub App API calls, private Cloudflare capability transport.

**Spec:** ../specs/2026-10-12-fixed-integration-signing-design.md

## Global constraints

- Integration ref: `refs/heads/int/<working-branch>`; no generation suffix.
- Each eligible candidate has exactly one parent, equal to current main.
- Never update an integration ref in place; delete and recreate it.
- Main is append-only and advances exactly one already-checked signed commit.
- Run repository checks exclusively against the integration candidate SHA.
- Keep source branches and PRs intact; source events run reconciliation only.
- Preserve existing staged work, preservation branches, and key material.
- No deployment, credential enrollment, protection changes, or live signing in tests.
- Use synthetic fixtures and temporary Git stores for implementation validation.

## Review focus

- A delayed job cannot delete the replacement that now occupies the same ref.
- A main update during publication blocks promotion and schedules regeneration.
- A closed historical PR with the same head ref must not be mistaken for the new PR.
- A branch name containing nested paths or dots maps exactly without unsafe Git refs.
- Lost provider responses and repeated events must not cause duplicate PRs or signing.

## Working locations

Create isolated implementation worktrees from the verified preservation heads
for workflow_depot, repoctl, delivery_control, ProsRUs, personal-control,
backup-control, and ghcaretaker. Do not reset or restage their current worktrees.
Preserve the separately committed design documents when creating the depot
implementation branch. Copy signing-control-staging into an isolated source
directory excluding dependencies, runtime files and credentials; retain its
relative layout. Its remote creation is a release prerequisite, not a reason
to invent a new repository or move signer ownership into workflow_depot.

Paths below are relative to the named project. Keep repoctl's embedded delivery
copies synchronized with the standalone delivery files. Keep the signer's
vendored repoctl source synchronized and update its provenance using the
repository's existing mechanism.

### Task 1: Fixed refs and generation-aware candidate identity

**Files:** repoctl `controller/src/source-signing/{core,git}.mjs`, new
`controller/src/source-signing/integration-ref.mjs`,
`controller/test/source-signing.test.mjs`; signer
`src/vendor/repoctl/source-signing/*`, `src/vendor/repoctl/provenance.json`.

**Interfaces:** `integrationRef(sourceRef: string): string` validates a source
head ref and returns its fixed integration ref. `lookupCandidate` retains its
existing `{repositoryID, commitSHA, shadowRef}` input but resolves an immutable
commit-to-generation index, then verifies the active generation for that ref.
Generation IDs remain positive durable sequence numbers; never parse one from
the integration branch name.

- [ ] Add tests for `feature/randomTicket01234` mapping exactly to
  `refs/heads/int/feature/randomTicket01234`; support valid dotted/nested refs;
  reject main, integration refs, malformed refs, and source/ref mismatches.
- [ ] Add tests that signed commit S has one parent M, preserves concurrent main
  changes, and has `rev-list --count M..S == 1`; conflicts and no-op trees must
  not create a misleading integration PR.
- [ ] Run `node --test controller/test/source-signing.test.mjs` in repoctl and
  confirm new assertions fail before implementing the new contract.
- [ ] Implement the helper, fixed-ref construction, commit-generation index and
  active-generation lookup. Preserve exact signature and policy checks.
- [ ] Run the same tests, synchronize vendor files/provenance, then run signer
  `node --test test/service-git.test.mjs test/service-composition.test.mjs`.
- [ ] Commit the contract and tests on implementation branches.

### Task 2: Conditional ref deletion and generation-specific PR publication

**Files:** delivery_control `src/source-git.mjs`, `src/source-publisher.mjs`,
`test/source-git.test.mjs`, `test/source-publisher.test.mjs`; matching repoctl
`delivery_control/src/` copies.

**Interfaces:** Add `deleteRef({ref, expectedSHA})` and
`closePullRequest({number, headRef, headSHA})` to the publisher. Add
`pushDeleteOnly({repository, repositoryID, ref, expectedSHA, token, expiresAt})`
to normal Git transport. Extend PR lookup with an exact `headSHA`, selecting
only the open PR for the current generation. Existing create operations remain
create-only. Provider authorization digests bind every supplied field.

- [ ] Test deletion only at the expected SHA, rejection of main/tag deletion,
  and rejection when a newer replacement occupies the ref. Use a temporary
  bare remote to demonstrate stale expected-SHA deletion fails server-side.
- [ ] Test PR lookup with multiple closed historical PRs and one current open
  PR; two current matches must fail. Test closing only the recorded PR number.
- [ ] Run `node --test test/source-git.test.mjs test/source-publisher.test.mjs`
  and confirm new cases fail.
- [ ] Implement expected-SHA Git deletion and absent-ref-only creation. Use
  explicit expected leases, never unconditional force or API deletion after
  only a read. Handle successful no-content close/delete responses correctly.
- [ ] Implement generation-specific PR lookup and close authorization. Preserve
  bounded responses, repository identity checks and nonsecret error output.
- [ ] Run the focused tests and commit both standalone and embedded copies.

Git's explicit expected-ref lease and empty-source deletion semantics are
documented at https://git-scm.com/docs/git-push. Lease syntax is a conditional
guard; it must never be used to allow an in-place integration rewrite.

### Task 3: Durable replacement and retirement lifecycle

**Files:** repoctl `controller/src/source-signing/core.mjs`, new
`controller/src/source-signing/integration-lifecycle.mjs`, new
`controller/test/integration-lifecycle.test.mjs`; signer vendor copies,
`src/service/{run,adapters,authorization}.mjs`,
`cloudflare/{controller,confinement}.mjs`, corresponding signer tests.

**Interfaces:** `reconcileIntegration({repositoryID, sourcePRNumber})` reads
trusted current provider state and reconciles the desired candidate.
`retireIntegration({repositoryID, sourcePRNumber})` closes/deletes only the
recorded owned generation. Use a durable active record keyed by repository and
integration ref, an immutable generation record, and per-effect reservations.
The reconciler invokes existing prepare/publish entrypoints with exact inputs;
no signing or publication credentials are exposed to a workflow.

- [ ] Test source change and main change causing close, conditional delete,
  absence readback, create, exact-SHA readback and new PR, in that order.
- [ ] Test duplicate/out-of-order events, simultaneous workers, a stale worker
  attempting deletion, lost close/delete/create/PR responses, and a job crash
  between deletion and creation. Reconcile uncertain effects from readback;
  never clear a durable reservation merely because a request timed out.
- [ ] Test source close/retarget retirement, unsupported forks, unowned refs,
  conflicting source PR ownership, and immutable evidence invalidation.
- [ ] Run `node --test controller/test/integration-lifecycle.test.mjs` red.
- [ ] Implement serialized generation transitions and exact effect grants;
  update private capability allowlists and input schemas for lifecycle calls.
  Maintain fencing through all effects; do not rely solely on workflow concurrency.
- [ ] Run lifecycle, source-signing and signer capability/controller tests;
  commit after they pass.

### Task 4: Integration-only validation and evidence consumers

**Files:** workflow_depot `templates/app-ci.yml`,
`.github/workflows/{orchestration,review-candidate,test-contracts}.yml`,
`src/{candidate-admission-client,candidate-review,prior-job-evidence,
deployment-evidence,deployment-provenance}.mjs`, matching tests; signer
`.github/workflows/validate.yml`; consumer validation workflows in all seven
repositories discovered during the workflow audit.

**Interfaces:** Candidate admission retains repository ID, signed commit SHA,
and ref, but checks fixed-ref derivation and the authoritative current
generation instead of extracting a sequence from a branch regex. Evidence
remains bound to signed S, source head, parent M, policy and generation.

- [ ] Add contract tests proving ordinary source pushes/PRs and main pushes run
  no validation jobs; `int/**` pushes validate S, including draft PR candidates.
- [ ] Test that forged `int/` refs, synthetic merge SHAs, stale-generation
  results, and correct SHA with wrong source-ref mapping are rejected.
- [ ] Run `node --test test/orchestration.test.mjs test/source-admission-client.test.mjs
  test/prior-job-evidence.test.mjs test/deployment-evidence.test.mjs
  test/deployment-provenance.test.mjs` red.
- [ ] Change caller triggers to nested `int/**` pushes, checkout explicit S,
  and admit only service-owned current candidates. Remove duplicate ordinary
  PR/main validation triggers. Deduplicate by repository/generation and ensure
  cancelled or superseded runs cannot qualify a new generation.
- [ ] Update all evidence consumers and fixtures together. Audit external
  checks/rules read-only and report any remaining production configuration gap.
- [ ] Run the focused suites plus workflow contract tests and commit.

### Task 5: Trusted event entrypoint and exact main advancement

**Files:** workflow_depot new `src/integration-events.mjs`, new
`test/integration-events.test.mjs`, new trusted reconciliation caller template;
signer `cloudflare/controller.mjs` and lifecycle capability composition;
delivery_control `src/{execute,source-git}.mjs`, `test/execution.test.ts` and
`test/source-git.test.mjs`; repoctl embedded delivery copies and execution
boundary tests.

**Interfaces:** `handleIntegrationEvent({eventName, payload}, {source, reconciler})`
accepts authenticated PR/main events, re-fetches current source identity, and
calls task 3's reconciliation/retirement methods. Main events enumerate open
same-repository source PRs with bounded pagination. Ignore `int/` PRs and
deletion events as source changes. The main executor consumes an authorized
promotion `{repositoryID, baseSHA, commitSHA, treeSHA}` and conditionally
advances only from baseSHA to its verified one-parent child commitSHA.

- [ ] Test PR open/reopen/synchronize/retarget/close, main push fan-out, forks,
  stale delivery, invalid authentication, event recursion and pagination bounds.
- [ ] Test final promotion rejecting multiple parents, skipped commits, changed
  main, wrong signatures/trees, stale source generation and already-consumed
  authorization. Confirm successful promotion preserves every old main SHA.
- [ ] Run new event and existing execution tests red.
- [ ] Implement the authenticated entrypoint without executing source code in
  a privileged workflow. Use trusted pinned orchestration only. Wire required
  runtime capabilities explicitly; unavailable bindings must fail closed.
- [ ] Replace the read-then-PATCH main write with an expected-main operation in
  the trusted Git transport. Verify single-parent relationship locally before
  the write; use an exact expected-tip guard and verify the remote result.
  A lost acknowledgement must reconcile, not submit a new promotion blindly.
- [ ] Run event, execution and real temporary-Git race tests; commit.

Workflow event and merge-ref behavior is documented at
https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows.
Select a GitHub App event/publication path that can trigger downstream CI;
do not assume ordinary workflow-token writes trigger subsequent workflows.

### Task 6: Cross-component qualification and handoff

**Files:** workflow_depot new `test/fixed-integration-contract.test.mjs`, signer
README and service documentation, repoctl source-signing README,
delivery_control source-publication documentation, this plan's checkboxes.

- [ ] Add a synthetic end-to-end scenario: source PR -> signed S -> fixed ref
  and PR -> integration-only evidence -> exact main advancement. Follow with
  two feature updates and a competing main advancement, proving ref name reuse,
  old PR retirement, new checks and preservation of main history throughout.
- [ ] Run each changed project's focused suites and required repository checks
  from its own implementation tree. Do not run live signing or provider mutations.
- [ ] Review the complete diff for old numbered-shadow assumptions, ordinary
  PR/main validation triggers, nonconditional deletion, and unchecked promotion.
- [ ] Commit final documentation and report verified tests, implementation
  commits, and precise remaining commissioning blockers. Do not claim the
  automation is live without production configuration and event readback.

## Self-review

All spec areas map to tasks: fixed-name/single-commit invariants (1), conditional
publication (2), replacement and recovery (3), integration-only evidence (4),
events and append-only main (5), and cross-component verification (6). The five
review-focus cases each have explicit assertions above. Main protection and
signer commissioning remain release prerequisites; no task silently bypasses
them or substitutes a local signing key.

## Execution status

The six source implementation areas are present and the local suite results are
recorded in [verification](../fixed-integration-verification.md). The original
checklist is retained as a detailed qualification checklist: its broader live
provider audit and exhaustive crash/recovery assertions are not all certified
by these local tests. Cross-component coverage lives in repoctl's
`controller/test/source-signing.test.mjs`, alongside separate real-Git transport
tests. No activation or live integration PR is claimed.
