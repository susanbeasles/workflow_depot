# pipeline: the reusable CI pipeline

`pipeline/pipeline.yml` is the reusable workflow that every repository runs on its pull requests and shadow
candidates. Contract: infra-root ADR-0002 section 1 (job ids, check names, needs), ADR-0001 section 1
(promotion), [docs/PROMOTION.md](../docs/PROMOTION.md). It is staged here because `.github/workflows/` is
protected; the owner installs it.

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
2. Copy `pipeline/caller.yml` to the repository as `.github/workflows/ci.yml`, replacing
   `0000000000000000000000000000000000000000` with that SHA. Keep the job id `pipeline` and add no `name:` to it.
3. The repository's Actions policy must allow `susanbeasles/workflow_depot`. The `shadow` and `promote` jobs
   check out workflow_depot with a token that has only `id-token: write`. That works while workflow_depot is
   public. If it becomes private, its Actions access setting must cover the caller repositories.

## What runs

| Job | Check name | When | Needs | Permissions | Does |
|---|---|---|---|---|---|
| `lint-test` | `pipeline / lint-test` | every run | | `contents: read` | install, lint, typecheck, test |
| `quality` | `pipeline / quality` | every run | | `contents: read` | actionlint, zizmor, lockfile check, commit messages |
| `security` | `pipeline / security` | every run | | `contents: read` | gitleaks (tree and commit range), `npm audit` |
| `build-candidate` | `pipeline / build-candidate` | every run | the three above | `contents: read` | build, package, immutable artifact upload |
| `build` | `pipeline / build` | every run | `build-candidate` | `contents: read` | download exact artifact ID, compute digest (no GitHub attestation; releases are cosign-signed) |
| `shadow` | `pipeline / shadow` | non-draft `pull_request` into `main` from this repository | `build` | `id-token: write` | `actions/request-shadow` |
| `promote` | `pipeline / promote` | `push` to `shadow/pr-*` | `build` | `id-token: write` | `actions/request-promotion` with the artifact digest |

The first four run in parallel where they can. Callers need no configuration for a Node repository with a
`package-lock.json`. Inputs, all optional:

| Input | Default | |
|---|---|---|
| `node-version` | `24` | |
| `working-directory` | `.` | where `package.json` lives |
| `install` | `npm ci --ignore-scripts` | lifecycle scripts stay off |
| `lint` / `typecheck` | `npm run lint --if-present` / `npm run typecheck --if-present` | |
| `test` | `npm test` | empty skips it, with a warning |
| `build` | `npm run build --if-present` | |
| `artifact-path` | empty: `npm pack` output | a file, or a directory packed as a deterministic `tar.gz` |

An empty command skips its step. Commands come from the caller's workflow file, never from PR content, and reach
the shell only through `env:`.

## Security properties, and why

- `permissions: {}` at the top, minimal grants per job, `timeout-minutes` everywhere, GitHub-hosted
  `ubuntu-24.04` only, every checkout `persist-credentials: false`, no `pull_request_target`.
- Every `uses:` is pinned to a full SHA (resolved with `git ls-remote`):

  | Action | SHA | Tag |
  |---|---|---|
  | actions/checkout | `3d3c42e5aac5ba805825da76410c181273ba90b1` | v7.0.1 |
  | actions/setup-node | `820762786026740c76f36085b0efc47a31fe5020` | v7.0.0 |
  | actions/upload-artifact | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | v7.0.2 |

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
  are escaped before they reach a workflow command.
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

### Signing isolation

Candidate install/build/package code runs in `build-candidate` without OIDC or attestation permissions.
The existing required `pipeline / build` check runs on a fresh runner, downloads the immutable artifact
ID from the same workflow run, validates one regular file, recomputes its digest and attests those bytes.
It does not check out candidate code or run package tooling. Shadow/promotion still depend on `build`;
no authorizer check names change. This adds a job to the original ADR-0002 job table to separate signing authority.

## Embedded scripts

The jobs other than `shadow` and `promote` have no checkout of workflow_depot, so the scripts in
`pipeline/scripts/` run inline as `shell: node {0}` steps, copied byte for byte. Edit the `.cjs` file, then run:

```
node pipeline/embed.mjs          # rewrite the marked run: blocks in pipeline/pipeline.yml
node pipeline/embed.mjs --check  # exit 1 if pipeline.yml is stale
```

| Script | Step | |
|---|---|---|
| `workflow-sha.cjs` | `shadow`, `promote`: route | `job_workflow_sha` from the job's OIDC token |
| `commitlint.cjs` | `quality`: commit messages | Conventional Commits. On PRs, every commit in `base..head`; merges skipped, `fixup!`/`squash!`/`amend!`/`Revert "` accepted because the promoter squashes them. On candidates, the commit itself, strictly; its message is the PR title |
| `lockfile-check.cjs` | `quality`: lockfile | refuses a missing or v1 lockfile, drift from `package.json`, and any package that is not an https tarball with an integrity hash (sha1-only is a warning) |
| `package.cjs` | `build`: package | `npm pack --ignore-scripts`, a file as is, or a directory as GNU tar sorted, mtime 0, owner 0, normalized modes, gzip mtime 0; outputs `artifact_digest=sha256:<hex>` |

## Not wired here

- **security-assurance** (`security-assurance/`, `.github/workflows/security-assurance.yml`) is not called from
  `security`, because it is neither self-contained nor offline-safe. It is its own reusable workflow of about 30
  jobs. It downloads scanners and vulnerability databases at run time (trivy and grype DBs, ClamAV `freshclam`,
  the OSV API), needs GitHub Advanced Security for CodeQL, uploads an evidence bundle, and signs with its own
  workflow identity. Its own README says it still needs a first real run. Calling it as a nested reusable
  workflow would add check names outside the ADR table and multiply the pipeline's run time. Gap: repositories
  that want it call it from a separate caller workflow. Its `gate-decision.json` is not evidence the authorizer
  reads today. A comment in `security` marks where a future, offline-capable hook belongs.
- **Runner telemetry** (`actions/runner-telemetry`, ADR-0001 section 3) is built separately. A comment in
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
