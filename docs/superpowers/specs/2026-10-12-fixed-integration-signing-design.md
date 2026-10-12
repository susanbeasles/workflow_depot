# Fixed-name signed integration PRs

Status: design for review; no runtime behavior changed.

## Agreed outcome

Opening a working-branch PR against main produces a parallel integration PR
against main. For working branch `feature/randomTicket01234`, the integration
branch is exactly `int/feature/randomTicket01234`. Every eligible integration
candidate consists of one signed squash commit whose sole parent is current
main. Original working commits and the original PR remain intact.

An integration ref is never updated in place, amended, rebased, or force-pushed.
When either input changes, close the previous integration PR, delete its ref,
and recreate the identical ref with a new signed squash commit. Open a new PR.
No sequence suffix appears in the branch name.

All repository builds, tests, lint, scans, automated review, and required checks
run exclusively against the signed integration candidate. Working branches,
working PRs, and main updates trigger reconciliation only, never a parallel
validation pipeline. No working-branch check result is required or accepted.

## Ownership and existing implementation

The dedicated signing source is currently `/workspace/signing-control-staging`,
intended for `susanbeasles/signing_control`. Its remote existence and production
commissioning remain unverified. Keep signing isolated there; it does not own
deployment, ordinary feature commits, or final main promotion.

`workflow_depot` owns accepted signing policy, candidate verification and check
orchestration. The authorized publisher in `delivery_control` owns GitHub ref
and PR effects. Existing source-signing code in repoctl and the signer's vendored
copy constructs squash trees and signatures, but assumes immutable
`promotion/<sequence>/shadow` refs. Those assumptions must change together with
workflow ref filters, candidate lookups, publication authorization, tests, and
vendor provenance. Internal immutable generation IDs remain necessary, even
though the public branch name is reused.

The service signs exact authorized Git commit bytes. PR content must never
select executable signer code or gain access to the signing credential.

## Events and candidate identity

Reconcile on a source PR opening, reopening, head update, or retargeting to
main, and on each main update. Retargeting away from main or closing the source
PR retires its integration candidate. Ignore integration PRs as source events
to prevent recursion. Duplicate and out-of-order events trigger reconciliation
against current provider state rather than replaying an old desired state.

Initial scope is same-repository working branches; fork PRs fail closed with
an explicit unsupported result because their branch names can collide.
Only one active source PR may own a given integration ref.

Identify each generation by repository ID, source PR number, source head SHA,
main SHA, integration ref, internal generation ID, signer key ID, and policy
digest. Receipts, checks, approvals and deletion authority bind that identity.
Matching the branch name alone never proves candidate identity.

## Construction and replacement

1. Serialize reconciliation per repository and integration ref. Read current
   source PR, source head and main. Invalidate merge eligibility for obsolete
   generations immediately.
2. Retain source history and compute the three-way squash result onto current
   main with Git. A conflict blocks candidate construction; do not substitute
   the source head tree and thereby discard newer main changes.
3. Construct one commit with the resulting tree and exactly one parent: the
   captured main SHA. Sign and independently verify its exact bytes and key.
   Even a zero-net-diff candidate must never create multiple commits; report
   no changes and retire the previous integration PR instead of creating an
   empty PR that GitHub cannot represent usefully.
4. Re-read both inputs. Discard a stale prepared candidate before publication.
   Locate the previous integration PR and ref using durable ownership records.
5. Mark that PR superseded, close it, and delete only the service-owned ref at
   its recorded expected SHA. Confirm absence before creating the replacement.
   Never delete an unexpected ref or another generation's replacement.
6. Create the same `refs/heads/int/<working-branch>` ref at the new signed SHA;
   confirm its exact value. Create a new draft PR targeting main and link it to
   the original source PR and superseded integration PR.
7. Run fresh checks against the exact signed SHA. Previous checks and approvals
   cannot qualify the replacement. Re-read source head, main and integration
   SHA before making the candidate eligible for promotion.

An unchanged input tuple is a no-op when its candidate is already published.
A durable operation journal records every external effect. After an ambiguous
response, reconcile provider state before any retry; never blindly repeat
deletion, signing, or PR creation. A partial replacement stays blocked and is
recoverable without modifying the source branch.

## Integration-only checks

Check orchestration accepts only a service-owned `int/<working-branch>` ref
with an active generation and its exact signed commit S. A matching name alone
is insufficient. Check out S explicitly, verify it matches the integration PR
head and retained candidate, and execute all repository validation against S.
Do not validate the original working head, a provider-generated PR merge commit,
or a moving branch name resolved later in the job.

Working-PR events and main updates may invoke trusted reconciliation logic to
construct, sign, and replace candidates. That logic reads source objects and
verifies identity, authorization, signature, and parentage; it does not run
repository builds, tests, scans, or review against the working branch or main.

Use one validation run per integration generation and deduplicate overlapping
branch/PR notifications. Attach check results to S and the integration PR.
On replacement, cancel obsolete runs where possible and reject their results
regardless of cancellation success. Reused ref names cannot reuse evidence.
Validation failures block integration promotion; the original working PR has
no required validation pipeline and is never the main-promotion vehicle.

Audit existing caller workflows, reusable workflows, external checks, and
required-check rules so that broad push/PR triggers do not keep validating
working branches or main in parallel. Production enforcement is not complete
until those integrations are verified. Integration checks must remain active
for draft integration PRs; draft status must not silently skip validation.

## Restricted ref and concurrency requirements

The publishing identity must be authorized to create and delete `int/*` refs
while ordinary writers cannot modify them. A lock alone cannot protect against
another writer outside that lock. Verify provider rules and the deletion
mechanism before activation; if expected-generation deletion cannot be assured,
stop rather than issue an unconditional delete against a reused ref.

No arbitrary GitHub protections or bypass settings are changed as part of
implementing this design. Required production settings must be reported and
separately reviewed before activation.

## Main plus one invariant and promotion

For signed candidate S and current main M, require exactly one parent of S,
that parent equals M, and `git rev-list --count M..S` equals 1. The integration
ref and integration PR head must both equal S. Source head must still match the
generation, and required evidence must refer to S.

Independent provider events cannot guarantee every open PR remains main plus
one at every instant. The hard guarantee is eligibility: stale candidates are
blocked, replacements are reconciled, and final promotion must conditionally
advance main from the expected M to the exact S. A competing main update must
fail that operation and require regeneration. A fresh read followed by an
unconditional write is insufficient.

Do not use a final merge method that creates a different commit or rewrites S.
Signing and shadow publication do not themselves authorize main promotion.
Existing approval requirements remain in force.

## Validation and release boundaries

Use synthetic signing fixtures and temporary Git repositories to validate:
single-parent/single-commit construction; preservation of main changes; merge
conflicts and no-op diffs; exact fixed ref names; deletion before recreation;
new PR creation; source/main changes during signing and publication; duplicate
events; stale worker deletion attempts; ambiguous provider outcomes; stale
checks and approvals; unowned refs; source closure; and conditional promotion.
Verify that working-branch pushes/PRs and main updates start no repository
validation jobs, integration events validate only S, generated merge commits
are never checked out, duplicate events start no duplicate validation, and
results from superseded generations cannot qualify their replacements.

Update producer/consumer contract tests together. No live key access, new key
creation, deployment, activation, or protection changes belong to these tests.

Implementation must first map all existing immutable-ref consumers, then
introduce generation-aware fixed-ref contracts, reconciliation and publisher
effects, and finally connect trusted PR/main events. Production readiness also
requires a confirmed signer repository, commissioned signing runtime, verified
GitHub permissions/rules, and a promotion mechanism with conditional main
advancement. These are release prerequisites, not evidence of existing setup.
