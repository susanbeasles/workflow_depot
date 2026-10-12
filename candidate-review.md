# Shared candidate review

The reusable `review-candidate.yml` job runs the trusted depot runtime on
`ubuntu-24.04` with Node 24. It checks out only `susanbeasles/workflow_depot` at a
source-owned immutable revision. Application code is read as bounded raw GitHub
Contents responses at the exact signed candidate S and its approved main parent
M. Tree metadata and Git blob hashes bind the returned bytes. The reviewer never
checks out the application, installs its dependencies, restores its CI environment
or executes its scripts. Binary files, symlinks, submodules, truncated trees and
unsupported size limits produce unavailable evidence rather than silent omissions.

The scanner report is the only downloaded artifact. The pinned orchestration
passes its immutable artifact ID and raw SHA-256 directly from the successful
scan job. The reviewer requires exactly one bounded regular `scan-report.json`,
canonical JSON, the exact raw digest, repository/S/tree/run/attempt coordinates,
full inventory and tool coverage under accepted scanner policy. It also checks
each reviewed source file against the report's byte inventory. The report is
parsed data; it is never imported or executed. Passing GitHub job metadata has a
`scanJobDigest`; the actual validated scanner receipt has a different
`scanReceiptDigest`.

The existing candidate authority independently verifies the current signed S,
original source P, main parent M and the current generation at the fixed integration reference. Its private
`lookupReviewPolicy({repositoryID,commitSHA,shadowRef})` capability returns the
retained, accepted candidate review configuration. A missing configuration is
explicitly null; invalid configuration or source drift fails. The API response
binds that configuration to repository ID, S and the source policy digest. Its
review and scan policies must exactly equal the source signer's retained policies.
No credentials are returned.

The CLI composes that proof with `verifyPriorJobs`: actual repository and run
identity, exact run attempt and S, accepted workflow ID, actual caller workflow
bytes/digest, pinned reusable workflow, authorized actors and every required
completed successful job. The overall run may still be in progress because this
review job runs after those jobs. Missing, skipped, stale or failed evidence
prevents model invocation. The final candidate and accepted policy are read again
before any approved receipt is returned.

The style guide is the actual **Engineering rules** document from
`susanbeasles/ProsRUs`, revision
`6c0a71c43934dc6428449a4b96b2b88a7ba47fac`, path `docs/code-style-guide.md`, SHA-256
`e672eabc9538121bfd73edc9b685e9c7ce2dd3f1be1cccc31f984f0d9e9dd29d`.
Its exact bytes and attribution are retained in the reviewer module. No file
named `anthony-code-style-guide.md` was located or substituted. Accepted policy
also supplies bounded, versioned language, framework and dependency documents
with verified content hashes. Deterministic checks use explicitly accepted fixed
rule IDs; they do not claim to prove every semantic engineering rule.

The reviewer requires a distinct configured GitHub App, source installation and
bot actor. Read-only GitHub API checks verify those identities and an existing
in-progress check for exactly S. Neither the Actions triggering actor nor the
default Actions token is accepted as the independent reviewer identity. The
adapter does not mint credentials, create checks or post review conclusions.
Existing runtime-issued short-lived App authentication must be commissioned;
putting an expiring static App JWT in workflow secrets does not solve this.

The optional OpenAI Responses adapter uses a fixed API origin, strict structured
output, no tools, no stored response and bounded requests/responses. It requires
an explicit installed repository/policy-scoped source-upload authorization and a
credential capability before making a request. Neither is configured here, and
no external source upload is currently authorized. Synthetic fetch tests are not
permission to enable that adapter. Selecting a provider requires separate
authorization consistent with the owner's data boundary. Provider findings must
cite an exact candidate path and complete source line. Medium or higher findings,
inconclusive review, missing provider or missing independent identity cannot
produce an approved receipt.

An approved result is compatible with `repoctl-source-review/v1`, is bounded by
the freshness of the prior jobs, and is returned as workflow metadata with its
canonical digest. It is automated review evidence, not human review or owner
authorization. Detached hardware owner approval and exact main promotion remain
separate gates. Production receipt custody/check completion and the source
controller's authenticated review reader still require commissioning; merely
copying a workflow output is not independently authenticated promotion evidence.

## Commissioning without circular commit pins

1. Review and publish the common runtime commit A. Its source-owned
   `reviewPolicies` registry contains only `{repository,provider}` allowlist/local
   provider choices. It contains neither A's own SHA nor future workflow/caller
   hashes. The registry and credential capabilities are currently empty/absent.
2. Review a workflow revision B whose literal `REVIEWED_DEPOT_SHA` points to A,
   then prepare the thin source caller pinned to B. The runtime revision and
   workflow revision may differ. The sentinel currently prevents job execution.
3. Independently accept B's workflow identity, exact source caller byte digest,
   workflow/job/actor identities, applicable documents and scanner/reviewer
   policies in the existing private source policy authority. This occurs after
   A, B and the caller bytes exist, so no commit embeds its own future hash.
4. Retain that metadata as `config.candidateReviewPolicy` before preparing a
   candidate. Its exact fields are `ownerID`, `reviewPolicy`, `scanPolicy`,
   `priorJobs`, `applicablePolicy`, and `maxAgeSeconds`. `priorJobs` contains the
   fields documented by `verifyPriorJobs`, excluding `policyDigest`; the private
   lookup supplies the retained source policy digest. `reviewPolicy` and
   `scanPolicy` must equal their existing source policy counterparts. No runtime
   SHA, vendor credentials or executable policy is accepted in this metadata.

Local tests exercise real composition with synthetic GitHub/provider responses,
not live review access or provider qualification. Required scanner categories
without installed qualified tools remain blocking. Nothing here opens a PR,
publishes a shadow reference, pushes tags, changes branch protection, fast-forwards
main, deploys an application, or reads a real credential.
