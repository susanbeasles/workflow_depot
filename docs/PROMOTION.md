# Promotion: shadow integration and fast-forward-only `main`

How a repository's pull request becomes a commit on `main`. Contract: `infra-root/docs/adr/0001-pipeline-surround.md`
section 1. Repositories never decide: these actions only ask the authorizer, which verifies and calls the promoter.

```
PR push ──► pipeline on the PR ──► request-shadow ──► authorizer ──► promoter builds S on shadow/pr-<n>
                                                                                     │ (push by the App)
shadow/pr-<n> push ──► pipeline on S ──► request-promotion ──► authorizer ──► promoter: main := S (ff only)
                                                                                     └► tag promote/pr-<n>-<sha12>
```

- `S` is the PR squashed onto the current `main` tip: one parent, the merged tree. The pipeline that decides
  the promotion ran on `S` itself, so `main` only ever holds a tree that was built, scanned, attested and signed.
- If `main` moves while `S` runs, the promoter rebuilds `S'` and pushes it; the run on `S` ends as
  "superseded" (green, with a warning) and the run on `S'` decides.
- The PR is closed with a comment naming the commit and the provenance tag. GitHub shows it closed, not merged.

## Actions

| Action | Runs on | Needs | Outputs |
|---|---|---|---|
| `actions/request-shadow` | `pull_request` into `main`, after the pipeline jobs passed | `permissions: id-token: write` | `candidate_sha`, `shadow_ref`, `reused` |
| `actions/request-promotion` | `push` to `shadow/pr-<n>`, after the pipeline jobs passed | `permissions: id-token: write`; input `artifact-digest` when policy requires an attestation | `outcome` (`promoted` or `stale_base`), `main_sha`, `tag` |

Both send the job's OIDC token (audience `services.susanb.dev`) to `https://services.susanb.dev/v1/token`, never
follow a redirect (a 3xx means an Access application is misconfigured), bound every response, and print only
the authorizer's stable refusal code and short detail. Neither holds or prints a credential.

## Caller workflow

The pipeline is one reusable workflow, `susanbeasles/workflow_depot/.github/workflows/pipeline.yml`
(infra-root ADR-0002 section 1). `shadow` and `promote` are jobs **inside** it, so their OIDC tokens carry
`job_workflow_ref = susanbeasles/workflow_depot/.github/workflows/pipeline.yml@<sha>` and `job_workflow_sha`,
which a caller cannot forge. Repositories do not call these actions themselves.

It is staged at [`pipeline/pipeline.yml`](../pipeline/pipeline.yml), because `.github/workflows/` is protected.
The owner installs it with one command; see [`pipeline/README.md`](../pipeline/README.md). Each repository adds
[`pipeline/caller.yml`](../pipeline/caller.yml) as `.github/workflows/pipeline.yml`, next to its `pipeline.json`
(the full stage map is [pipeline.md](pipeline.md)):

```yaml
name: pipeline
on:
  pull_request: {branches: [main], types: [opened, synchronize, reopened, ready_for_review]}
  push: {branches: [main, 'shadow/pr-*'], tags: ['v*.*.*']}
permissions: {}
concurrency: {group: 'pipeline-${{ github.ref }}', cancel-in-progress: "${{ github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/tags/') }}"}
jobs:
  pipeline:
    uses: susanbeasles/workflow_depot/.github/workflows/pipeline.yml@0000000000000000000000000000000000000000 # REPLACE: reviewed workflow_depot SHA
    permissions: {contents: write, id-token: write, attestations: write, security-events: write}
    with: {depot_ref: '0000000000000000000000000000000000000000'}
    secrets: {RELEASE_DISPATCH_TOKEN: '${{ secrets.RELEASE_DISPATCH_TOKEN }}'}
```

| Job | Check name | Runs on | Needs |
|---|---|---|---|
| `lint-test` | `pipeline / lint-test` | PR and candidate | |
| `quality` | `pipeline / quality` | PR and candidate | |
| `security` | `pipeline / security` | PR and candidate | |
| `build` | `pipeline / build` | PR and candidate | lint-test, quality, security (and `config`; `security` also needs `security-assurance`) |
| `shadow` | `pipeline / shadow` | `pull_request` into `main` (not drafts, not forks) | build |
| `promote` | `pipeline / promote` | `push` to `shadow/pr-*` | build |

Notes:

- The calling job id must be `pipeline`, with no `name:`: check names are `<caller job> / <called job>`.
- The authorizer's policy lists the check names that must be green on the requesting run attempt
  (`required_jobs` in its policy). Per ADR-0002 section 2 these are
  `pipeline / lint-test`, `pipeline / quality`, `pipeline / security` and `pipeline / build`, never `shadow`
  or `promote` themselves. `pipeline/test` checks the policy against the pipeline.
- `shadow` and `promote` run `actions/request-shadow` and `actions/request-promotion` at **the workflow_depot
  commit the reusable workflow runs at**. They read `job_workflow_sha` from the job's own OIDC token (audience
  `workflow-depot-route`, accepted by no service), check out workflow_depot at exactly that SHA, and run
  `main.mjs`. `promote` passes `needs.build.outputs.artifact_digest` as `INPUT_ARTIFACT_DIGEST`.
- The authorizer pins the pipeline to reviewed workflow_depot commits (`pipeline_workflow.allowed_shas` in its
  policy). A caller pinned at a SHA presents that SHA, so add each reviewed SHA there before moving callers to it.
- Draft PRs run every stage but never ask for a candidate. Marking the PR ready starts the run that does.
- Pushes by the promoter App trigger workflows (unlike pushes with `GITHUB_TOKEN`), so the run on `S` starts
  on its own. `cancel-in-progress` per ref cancels the run on a superseded candidate.
- Rulesets: only the promoter App may update `main`, create `shadow/*` and create `promote/*` tags; tags are
  immutable. A PR no longer needs a merge button: the promoter is the merge.

## Develop

```
node --test actions/test/promotion-actions.test.mjs
node --test pipeline/test/*.test.mjs
```
