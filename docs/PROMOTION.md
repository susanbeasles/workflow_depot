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

`.github/workflows/` is protected in every guarded repository, so the owner adds this file. Pin both actions
and the pipeline to a reviewed full commit SHA of `workflow_depot`.

```yaml
name: pipeline
on:
  pull_request:
    branches: [main]
  push:
    branches: ['shadow/pr-*']
permissions: {}
concurrency:
  group: pipeline-${{ github.ref }}
  cancel-in-progress: true
jobs:
  stages:
    # Stages 1 to 4 (lint and test, quality, security, build and attest). Until pipeline.yml lands in
    # workflow_depot, call the repository's existing checks here.
    uses: susanbeasles/workflow_depot/.github/workflows/pipeline.yml@0000000000000000000000000000000000000000 # REPLACE: reviewed SHA
    permissions:
      contents: read
      id-token: write
      attestations: write
      packages: write
  shadow:
    if: github.event_name == 'pull_request'
    needs: stages
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
      id-token: write
    steps:
      - uses: susanbeasles/workflow_depot/actions/request-shadow@0000000000000000000000000000000000000000 # REPLACE: reviewed SHA
  promote:
    if: github.event_name == 'push' && startsWith(github.ref, 'refs/heads/shadow/pr-')
    needs: stages
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    permissions:
      id-token: write
    steps:
      - uses: susanbeasles/workflow_depot/actions/request-promotion@0000000000000000000000000000000000000000 # REPLACE: reviewed SHA
        with:
          artifact-digest: ${{ needs.stages.outputs.artifact_digest }}
```

Notes:

- The authorizer's policy lists the check names that must be green (`required_pr_checks` for the PR head,
  `required_candidate_checks` for `S`). List the `stages` jobs there, never `shadow` or `promote` themselves.
- Pushes by the promoter App trigger workflows (unlike pushes with `GITHUB_TOKEN`), so the run on `S` starts
  on its own.
- Rulesets: only the promoter App may update `main`, create `shadow/*` and create `promote/*` tags; tags are
  immutable. A PR no longer needs a merge button: the promoter is the merge.

## Develop

```
node --test actions/test/promotion-actions.test.mjs
```
