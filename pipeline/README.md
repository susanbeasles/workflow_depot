# pipeline: the reusable CI pipeline

`pipeline/pipeline.yml` is the orchestrator every repository calls for pull requests, shadow candidates, `main`
and release tags: CONTROL-PLANE-SPEC section 5.6 stages 1 to 7, with the check names of infra-root ADR-0002
section 1 and the promotion of ADR-0001 section 1 ([docs/PROMOTION.md](../docs/PROMOTION.md)). Stage map, what
each existing workflow contributes and the open questions: [docs/pipeline.md](../docs/pipeline.md). Repository
input: `pipeline.json`, [docs/contracts.md](../docs/contracts.md) section 12. It is staged here because
`.github/workflows/` is protected; the owner installs it.

## Install (owner)

From the root of a workflow_depot checkout, on a branch, then open a PR:

```
cp pipeline/pipeline.yml .github/workflows/pipeline.yml
```

`node --test pipeline/test/*.test.mjs` fails whenever an installed `.github/workflows/pipeline.yml` differs from
`pipeline/pipeline.yml`, so the two cannot drift silently. Change `pipeline/pipeline.yml`, then reinstall it
with the same command.

After that PR merges, for each repository:

1. Add the merged workflow_depot commit SHA to the authorizer's pin for the pipeline, by reviewed PR in the
   authorizer repository (`policy/actions.json` `pipeline_workflow.allowed_shas`, empty today). A caller pinned
   at a SHA presents `job_workflow_ref = ...pipeline.yml@<sha>`, so any other SHA gets `bad_workflow`. Promotion
   also stays off until the authorizer's `promotion_enabled` is set after ADR-0002 acceptance.
2. Copy `pipeline/caller.yml` to the repository as `.github/workflows/pipeline.yml`, replacing both
   `0000000000000000000000000000000000000000` with that SHA (`uses:` and `depot_ref`), and add `pipeline.json` at
   the repository root. Keep the job id `pipeline` and add no `name:` to it. workflow_depot itself must not use
   that file name for a caller: its `.github/workflows/pipeline.yml` is this reusable workflow.
3. The repository's Actions policy must allow `susanbeasles/workflow_depot`. The `shadow` and `promote` jobs
   check out workflow_depot with a token that has only `id-token: write`. That works while workflow_depot is
   public. If it becomes private, its Actions access setting must cover the caller repositories.

## What runs

| Job | Stage | Check name | When | Needs | Permissions | Does |
|---|---|---|---|---|---|---|
| `config` | | `pipeline / config` | every run | | `contents: read`, `id-token: write` | `depot_ref` must equal the pinned SHA (`job_workflow_sha`); validates `pipeline.json` |
| `lint-test` | 1 | `pipeline / lint-test` | every run | config | `contents: read` | install, lint, typecheck, test, coverage at the profile threshold |
| `quality` | 2 | `pipeline / quality` | every run | config | `contents: read` | actionlint, zizmor, lockfile check, commit messages |
| `security-assurance` | 3 | `pipeline / security-assurance / ...` | every run | config | `contents: read`, `security-events: write`, `id-token: write` | `.github/workflows/security-assurance.yml`: admission, analysis, final gate, signed evidence |
| `security` | 3 | `pipeline / security` | unless cancelled | config, security-assurance | `contents: read` | security-assurance decision must be `PASS`; gitleaks (tree and commit range), `npm audit` |
| `build` | 4 | `pipeline / build` | every run | config and the three above | `contents: read`, `id-token: write`, `attestations: write` | one build, package, `sha256`, upload, provenance attestation, `gh attestation verify`, CycloneDX and SPDX SBOM |
| `shadow` | 5 | `pipeline / shadow` | non-draft `pull_request` into `main` from this repository | build | `id-token: write` | `actions/request-shadow` |
| `promote` | 5 | `pipeline / promote` | `push` to `shadow/pr-*` | build | `id-token: write` | `actions/request-promotion` with the artifact digest |
| `release` | 6 | `pipeline / release / ...` | `push` to `main` or a `v*` tag, `targets.applicationManifest` set | config, build | `contents: write`, `id-token: write`, `attestations: write` | `.github/workflows/release.yml` |
| `deploy` | 7 | `pipeline / deploy (<target>) / ...` | stage 6 released, `targets.deploy` not empty | config, release | `contents: read` | `.github/workflows/request-deployment.yml`, one leg per target |
| `infra-apply` | 7 | `pipeline / infra-apply` | terraform, `push` to `main` | config, build | none | fails closed: not wired |

For `ecosystem: terraform`, the first step of `lint-test` and `build` fails closed (no pinned OpenTofu; no
`terraform.plan` request), see docs/pipeline.md. Inputs:

| Input | Default | |
|---|---|---|
| `depot_ref` | required | the same full SHA as in `uses:`; `config` fails otherwise |
| `require-attestation` | `true` | `false` only where GitHub attestations are unavailable |

Secret, by name only, never `inherit`: `RELEASE_DISPATCH_TOKEN`, used only by `deploy`. Everything else comes from
`pipeline.json`, validated by `ci/pipeline-config.mjs` in `config`. Commands are npm script names run as
`npm run "$SCRIPT"`; values reach the shell only through `env:`.

## Security properties, and why

- `permissions: {}` at the top, minimal grants per job, `timeout-minutes` everywhere, GitHub-hosted
  `ubuntu-24.04` only, every checkout `persist-credentials: false`, no `pull_request_target`.
- Every `uses:` is pinned to a full SHA (resolved with `git ls-remote`):

  | Action | SHA | Tag |
  |---|---|---|
  | actions/checkout | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1 |
  | actions/setup-node | `820762786026740c76f36085b0efc47a31fe5020` | v7.0.0 |
  | actions/upload-artifact | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | v7.0.2 |
  | actions/attest-build-provenance | `4d101475d8b20a2381f78447822ac1eab6504dd8` | v4.2.2 (wraps actions/attest `508db95d…` v4.2.1) |

- Tools are pinned binaries, checked before use. **gitleaks 8.30.1**: the tarball sha256 from
  `security-assurance/policy/tool-registry.yml`, which cross-checked it against upstream checksums.
  **zizmor 1.30.1**: the tarball sha256 from the same registry. Upstream publishes no checksums file for it, so
  it is not cross-checked. **actionlint 1.7.12**: the tarball is checked against upstream
  `actionlint_1.7.12_checksums.txt`, then the extracted binary is checked against a pinned sha256.
- The repository cannot weaken its own checks. actionlint runs with an explicit empty config, zizmor with
  `--no-config`, and gitleaks with its built-in rules instead of the repository's `.gitleaks.toml`.
  `npm audit` uses the public registry and the threshold set on the command line, so a repository `.npmrc`
  cannot override them. Inline `zizmor: ignore` comments and a `.gitleaksignore` still apply. They are visible
  in review, and the job warns when a `.gitleaksignore` exists.
- zizmor fails on medium and high findings (regular persona, offline). Low and informational findings are not
  gated. `pipeline.yml` and `caller.yml` themselves have no findings at any severity in the regular and
  pedantic personas. The auditor persona reports only `misfeature` on `shell: node {0}`, which is deliberate
  (see "Embedded scripts").
- No `${{ }}` appears in any `run:` block, which rules out template injection. Commit text and lockfile text
  are escaped before they reach a workflow command. Nothing is passed to `eval`.
- Nested workflows are `./.github/workflows/<file>`: GitHub resolves them in this repository at the commit of
  `pipeline.yml` itself, so the caller's SHA pins them too. `config` refuses a `depot_ref` other than that SHA,
  so every workflow_depot checkout below it is the same commit.
- `build` caches nothing. `lint-test` caches npm's tarball store only when a lockfile exists, and `npm ci`
  re-verifies every integrity hash.
- `shadow` and `promote` run the request actions at **the workflow_depot commit `pipeline.yml` itself runs
  at**. `pipeline/scripts/workflow-sha.cjs` reads the job's OIDC token, takes its `job_workflow_sha` claim
  (no signature check: it only picks the commit to check out, and the authorizer verifies its own token),
  checks out workflow_depot at exactly that SHA, and verifies `HEAD` before running `main.mjs`. The routing
  token's audience is `workflow-depot-route`, which no service accepts, so a leaked routing token is worthless.
  A `sigstore`-audience token could obtain a signing certificate for the pipeline identity.
- Drafts never ask for a candidate. Promotion is automatic once a PR is green, so a draft is the way to push
  work in progress. Marking the PR ready (`ready_for_review` in the caller) starts the run that does ask. Fork
  PRs skip `shadow`: they get no OIDC token, and the authorizer refuses them (`is_fork`).

### Known limit: signing shares the build job

ADR-0002 fixes the job list, and the brief puts the attestation in `build`. Every step in a job can mint an
OIDC token once `id-token: write` is granted, so the caller's build tooling (devDependencies) shares the job
with the signer. A compromised build dependency could therefore attest an artifact of its choice under the
pipeline identity. It could already have tampered with the artifact itself, so this adds no new access, but it
falls short of SLSA Build L3 isolation. Two things narrow the risk: `npm ci --ignore-scripts`, and the
authorizer's binding of the attestation to the candidate commit and run. The isolated alternative is to
attest in `promote`, which runs no repository code: download the artifact, recompute its digest, compare it
with `needs.build.outputs.artifact_digest`, then attest. That needs `attestations: write` on `promote` and an
ADR amendment.

## Embedded scripts

The jobs other than `shadow` and `promote` have no checkout of workflow_depot, so the scripts in
`pipeline/scripts/` run inline as `shell: node {0}` steps, copied byte for byte. Edit the `.cjs` file, then run:

```
node pipeline/embed.mjs          # rewrite the marked run: blocks in pipeline/pipeline.yml
node pipeline/embed.mjs --check  # exit 1 if pipeline.yml is stale
```

| Script | Step | |
|---|---|---|
| `workflow-sha.cjs` | `config`, `shadow`, `promote`: route | `job_workflow_sha` from the job's OIDC token |
| `coverage-check.cjs` | `lint-test`: coverage | Istanbul json-summary `total.lines.pct` at or above the profile threshold |
| `commitlint.cjs` | `quality`: commit messages | Conventional Commits. On PRs, every commit in `base..head`; merges skipped, `fixup!`/`squash!`/`amend!`/`Revert "` accepted because the promoter squashes them. On candidates, the commit itself, strictly; its message is the PR title |
| `lockfile-check.cjs` | `quality`: lockfile | refuses a missing or v1 lockfile, drift from `package.json`, and any package that is not an https tarball with an integrity hash (sha1-only is a warning) |
| `package.cjs` | `build`: package | `npm pack --ignore-scripts`, a file as is, or a directory as GNU tar sorted, mtime 0, owner 0, normalized modes, gzip mtime 0; outputs `artifact_digest=sha256:<hex>` |

## Not wired here

See docs/pipeline.md "Gaps and open questions": the terraform stage 1, 4 and 7 requests, the image path, private
sourcemaps, a separate cosign signature on the build artifact, and stage 7 through the authorizer with OIDC.
**Runner telemetry** (`actions/runner-telemetry`, ADR-0001 section 3) is built separately. A comment in
`lint-test` marks where it goes: first in each job, once it is reviewed and pinned.

## For the owner: findings in existing workflows (protected path)

`zizmor 1.30.1 --offline --no-config --min-severity=medium .github/workflows` in this repository today reports
three high findings, which would fail workflow_depot's own `quality` job once it adopts the pipeline:

| File:line | Audit | Finding | Suggested fix |
|---|---|---|---|
| `.github/workflows/integration-quality.yml:139` | `unpinned-images` | `container.image: ${{ inputs.runner_image }}` may be unpinned | require an `@sha256:` digest (validate the input or pin the image) |
| `.github/workflows/integration-quality.yml:208` | `unpinned-images` | `container.image: ${{ inputs.agent_review_image }}` may be unpinned | same |
| `.github/workflows/security-assurance.yml:462` | `template-injection` | `IDENT="^https://github.com/${{ inputs.depot_repository }}/…"` inside `run:` | pass it as `env: DEPOT_REPOSITORY: ${{ inputs.depot_repository }}` and use `"$DEPOT_REPOSITORY"` |

There are also 36 `self-repository` (help) and 4 informational `template-injection` findings, which are not
gated. actionlint 1.7.12 also reports SC2086 (info) at `security-assurance.yml:139` (unquoted variables in
`run:`), which fails actionlint.

## Develop

```
node --test pipeline/test/*.test.mjs                      # structure, install drift, scripts, authorizer check names
node pipeline/embed.mjs --check
actionlint pipeline/pipeline.yml pipeline/caller.yml
zizmor --offline --no-config pipeline/pipeline.yml pipeline/caller.yml
```

The check-name test reads the authorizer policy from `../authorizer/policy/actions.json`, or from
`AUTHORIZER_POLICY`, and skips with a message when neither is present. YAML is parsed with python3 and PyYAML.
