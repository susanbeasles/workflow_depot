# The pipeline: one orchestrator, seven stages

`.github/workflows/pipeline.yml` (staged at [`pipeline/pipeline.yml`](../pipeline/pipeline.yml) until the owner
installs it) is the single reusable workflow every repository calls. It implements infra-root
`docs/CONTROL-PLANE-SPEC.md` section 5.6, keeps the job ids and check names of infra-root ADR-0002 section 1, and
promotes as ADR-0001 section 1 describes. Each repository has a ten-line caller and a `pipeline.json`
([contracts.md](contracts.md) section 12). This page maps every existing workflow and action onto the stages,
then shows what the orchestrator runs, when, and what is still missing.

## 1. Inventory: existing workflows mapped to stages

Every workflow below is `on: workflow_call` with `permissions: {}` at the top, except `agent-guard.yml`.

| Workflow | Triggers it accepts | Required inputs | Outputs | Secrets | Job permissions | Stage | Used by pipeline.yml |
|---|---|---|---|---|---|---|---|
| `security-assurance.yml` | any event (base SHA from the PR or `before`) | `depot_repository`, `depot_ref` (+18 optional: `policy_profile`, `admission_only`, `integration_artifact_name`, DAST, CodeQL, AI review, external evidence) | `decision` (`PASS`/`FAIL`) | `ANTHROPIC_API_KEY` (optional) | `contents: read`; `security-events: write` (codeql); `id-token: write` (evidence-sign) | 3 | **yes**, job `security-assurance`, full mode (`admission_only: false`: stage 0 admission, stage 2 analysis, final gate, cosign-signed evidence bundle), source only. No secret is passed, so the AI review stays off |
| `integration-quality.yml` | `push` to `refs/heads/int/*` only, private repositories only (its `identity` job asserts both) | `depot_repository`, `depot_ref`, `build_output`, `runner_image` (+20 optional) | none | `ANTHROPIC_API_KEY` (optional) | `contents: read`, `id-token: write` | 1 to 4 as one composition: admission, `ci/project-profile.mjs` quality and build in a digest-pinned image, full security on the build bytes, signed private release materials | **no**: it refuses `pull_request`, `main`, tags and `shadow/pr-*`, which are the events the spec runs stages 1 to 4 on. Its parts are used directly instead: security-assurance as stage 3; the same syft SBOM tool path in stage 4 |
| `release.yml` | `push` to `refs/heads/main` or a `vX.Y.Z` tag at `github.sha` | `depot_ref` (+ `application_manifest`, `r2_account_id`, `r2_bucket`) | `released`, `releaseTag`, `manifestSha256` | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (optional) | `contents: read`; attest `id-token: write`; publish `contents: write` | 6 | **yes**, job `release`, on `main` and `v*` tag pushes after `build`. R2 publication is not wired (no secrets passed) |
| `request-deployment.yml` | `push` to `refs/heads/main` only | `target`, `depot_ref` | none | `RELEASE_DISPATCH_TOKEN` (required) | `contents: read` | 7 (PAT) | **no**: it dispatches delivery_control with a PAT, which spec 5.2/5.4 forbids. `deploy` uses the authorizer OIDC client instead (section 4) |
| `request-app-deployment.yml` | `push` to `refs/heads/main` only | `target`, `depot_ref`, `app_id`, `app_client_id`, `app_slug`, `installation_id`, `private_key_ref`, `approval_ref` | none | `OP_SERVICE_ACCOUNT_TOKEN` (optional) | `contents: read` | 7 (alternative) | **no**: same receiver as `request-deployment.yml`; it needs a 1Password service-account token and six App commissioning values per repository, and the spec (v1.2) took 1Password out of the runtime path. One stage 7 path is wired, not two |
| `request-release.yml` | `push` to `refs/heads/main`, owner id 215839550 | none | none | `RELEASE_DISPATCH_TOKEN` | none | 6 (superseded) | **no**: dispatches a central release in delivery_control; `release.yml` publishes in the repository itself and is the stage 6 the spec describes. The spec (section 6) lists it for deletion |
| `main-deployment.yml` | `push` to `refs/heads/main` (through `accepted-main-artifacts.yml`) | six, all tied to an `int/*` integration run and retained owner evidence | none | `RELEASE_DISPATCH_TOKEN` | `contents: read`, `actions: read` | 7 (integration-branch model) | **no**: it consumes the `integration-release-<sha>` artifact of an `integration-quality.yml` run, which this pipeline does not produce. The spec lists it for deletion |
| `accepted-main-artifacts.yml` | `push` to `refs/heads/main`, private repositories | same six | none | none | `contents: read`, `actions: read` | between 6 and 7 (integration-branch model) | **no**, same reason |
| `validate-controller.yml` | any | `candidate_sha` | none | none | `contents: read` | none (delivery_control controller tests) | **no**: not a pipeline stage; the spec lists it for deletion |
| `agent-guard.yml` | `push`, `workflow_dispatch` | | | | | none (this repository's own guard) | no |

Composite actions and helpers:

| Action | Stage | Used |
|---|---|---|
| `actions/request-shadow`, `actions/request-promotion` (e2a3184) | 5 | yes: jobs `shadow` and `promote`, at the commit `pipeline.yml` runs at |
| `actions/_lib/authorizer.mjs` | 5 (and the future OIDC requests of 4t and 7) | through the two actions above |
| `.github/actions/compute-release-version` ... `publish-release-objects` (14 actions) | 6 | inside `release.yml`, unchanged |
| `.github/actions/submit-promotion-request` | 7 (RFC-001 admission) | **no**: needs the admission URL and audience from the Terraform registry, the current deployment generation and a GitHub Deployment id; nothing in the pipeline can supply the last two today |
| `security-assurance/.github/actions/install-tool` | 3, 4, 6 | yes: `build` installs the qualified syft with it (as `release.yml` and `integration-quality.yml` do) |
| `pipeline/scripts/*.cjs` (embedded) | 1, 2, 4, 5 | yes: `workflow-sha`, `lockfile-check`, `commitlint`, `package`, `coverage-check` |
| `ci/pipeline-config.mjs` | all | yes: job `config` validates `pipeline.json` |
| `ci/project-profile.mjs` | 1, 2, 4 | no: it runs only inside `integration-quality.yml` (it refuses any event but an `int/*` push). `pipeline.json` names the same four npm scripts it requires |
| `actions/runner-telemetry` | none | not yet: pending review and pinning (ADR-0001 section 3) |

## 2. The orchestrator

```
config ─┬─ lint-test (1) ─────────────────────────────┐
        ├─ quality (2) ───────────────────────────────┤
        └─ security-assurance (3, reusable) ─ security (3 gate) ─┴─ build-candidate (4) ─ build (4) ─┬─ shadow (5)   pull_request into main, non-draft, same repository
                                                                                            ├─ promote (5)  push to shadow/pr-*
                                                                                            ├─ release (6)  push to main or v* tag ── deploy (7, terminal status verified)  released, targets.deploy
                                                                                            └─ infra-apply (7, terraform)  push to main
```

| Stage | Job | Calls | Runs when | Needs | Permissions | Pass criterion it enforces |
|---|---|---|---|---|---|---|
| | `config` | `ci/pipeline-config.mjs` | every run | | `contents: read`, `id-token: write` (routing claim only) | `depot_ref` equals `job_workflow_sha`; `pipeline.json` valid; no unwired feature declared |
| 1 | `lint-test` | npm scripts from `pipeline.json` | every run | config | `contents: read` | `npm ci --ignore-scripts`; lint, typecheck and test scripts exit 0; Istanbul `total.lines.pct` at the profile threshold (80 `ci-baseline`, 90 `strict`) |
| 2 | `quality` | embedded checks | every run | config | `contents: read` | actionlint and zizmor (medium and up) on the caller's workflows, lockfile integrity, Conventional Commits. The typecheck runs in `lint-test` to share its install; strictness is the repository's script |
| 3 | `security-assurance` | `security-assurance.yml` | every run | config | `contents: read`, `id-token: write` | stage 0 PASS, stage 2 PASS, final `gate-decision.json` PASS, evidence bundle cosign-signed keyless, every control listed with a status |
| 3 | `security` | | every run that was not cancelled | config, security-assurance | `contents: read` | the `decision` output is `PASS`; gitleaks on tree and commit range; `npm audit` high |
| 4 | `build-candidate` | `npm run <scripts.build>`, `package.cjs`, syft | stages 1 to 3 green | config, lint-test, quality, security | `contents: read` | working directory inside the checkout; one build in the pinned Node version; deterministic package and `sha256`; CycloneDX and SPDX SBOM artifact. Lifecycle (`rebuild`) and build scripts are repository code, so this job holds no OIDC token |
| 4 | `build` | `download-artifact`, `hash-artifact.cjs` | default success dependency gating | build-candidate | `contents: read`, `id-token: write`, `attestations: write` | fresh runner hashes immutable same-run opaque bytes, then publishes GitHub provenance without executing candidate code |
| 5 | `shadow` | `actions/request-shadow` | `pull_request` into `main`, not a draft, not a fork | build | `id-token: write` | the authorizer builds the candidate on `shadow/pr-<n>` |
| 5 | `promote` | `actions/request-promotion` | `push` to `shadow/pr-*` | build | `id-token: write` | the authorizer verifies the four checks and the attestation on the candidate; `main` fast-forwards to it, provenance tag |
| 6 | `release` | `release.yml` | `push` to `main` or a `v*` tag, `targets.applicationManifest` set | config, build | `contents: write`, `id-token: write` | immutable `vX.Y.Z` from Conventional Commits; write-once GitHub Release with bundles, SBOMs, cosign and provenance bundles |
| 7 | `deploy` | `actions/request-deploy/main.mjs` | stage 6 output `released == 'true'` on `main` and `targets.deploy` not empty | config, release | `id-token: write` | one admission, bounded authenticated terminal readback, exact source/release/manifest/target identity; failure, rollback or uncertainty fails the job |
| 7 (terraform) | `infra-apply` | none | terraform, `push` to `main` | config, build | none | fails closed: not wired |

Rules every job follows: `permissions: {}` at the top and the minimum per job; GitHub-hosted `ubuntu-24.04`;
`timeout-minutes` on every runner job; every `uses:` of an action pinned to a full commit SHA; nested workflows
are `./.github/workflows/<file>`, which GitHub resolves in workflow_depot at the same commit as `pipeline.yml`;
no `pull_request_target`; no secrets at all (no `secrets: inherit`, no named secret); every checkout
`persist-credentials: false`; no `${{ }}` in any `run:` block and no `eval`; every job that uses the
`pipeline.json` working directory first checks that it is a real directory inside the checkout (no symlinked
component); repository code (lifecycle and build scripts) never runs in a job that holds an OIDC token.

What each event runs:

| Event | Jobs |
|---|---|
| `pull_request` into `main` (draft) | config, 1, 2, 3, 4 |
| `pull_request` into `main` (ready) | config, 1, 2, 3, 4, shadow |
| `push` to `shadow/pr-<n>` (the candidate) | config, 1, 2, 3, 4, promote |
| `push` to `main` (the promoted candidate) | config, 1, 2, 3, 4, release, then deploy with terminal readback when released and deploy targets exist |
| `push` of a `vX.Y.Z` tag | config, 1, 2, 3, 4, release (deploy runs only on `main`) |

`depot_ref` follows `release.yml`: the caller passes the same full SHA it pinned in `uses:`. `release.yml`
catches a mismatch late, when its signature identity check fails. `pipeline.yml` refuses it first: `config`
reads `job_workflow_sha` from its own OIDC token (audience `workflow-depot-route`, accepted by no service) and
fails unless it equals `depot_ref`, so every checkout of workflow_depot and every nested workflow is that one
commit.

The terraform variant (`ecosystem: terraform`, `infra` and `infra-root`) reads its stage 4 and 7 replacements
from `pipeline.json` (`terraform.plan`, `terraform.apply` or `root.apply`). Stages 2 and 3 run as for npm
(security-assurance includes the IaC scanners). Stage 1, stage 4 and stage 7 fail closed today; see section 4.

## 3. Caller

Install as `.github/workflows/pipeline.yml` in each repository, with `pipeline.json` at its root
([`pipeline/caller.yml`](../pipeline/caller.yml)):

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
    permissions: {contents: write, id-token: write, attestations: write}
    with: {depot_ref: '0000000000000000000000000000000000000000'}
```

- The job id must be `pipeline` with no `name:`: check names are `pipeline / <job>`, and the authorizer requires
  `pipeline / lint-test`, `pipeline / quality`, `pipeline / security` and `pipeline / build`.
- `shadow/pr-*` is in the push branches because stage 5 promotes from the candidate run on that branch.
- The caller grants the union of what the jobs inside declare; each job keeps only its own grant. `contents:
  write` is used only by `release`, which runs only on `main` and tag pushes.
- `cancel-in-progress` is false on `main` and tags, so a newer push never cancels a release half way.
- The caller passes no secrets.

## 4. Gaps and open questions

Stages that cannot be wired from what exists, and why:

1. **Stage 7 commissioning.** The staged workflow requests `deploy` with fresh GitHub OIDC, then polls `deploy.status` for up to 30 minutes. The job runs in the configured GitHub environment, executes only the SHA-pinned depot client, and never retries admission. `ALREADY_CURRENT` also requires exact terminal readback. Explicit `targets.application` and `targets.environment` are required; targets are not guessed to be applications. The installed workflow still requires owner installation. Current release producer/consumer formats differ, and no application is enrolled in the authorizer deployment policy. See `pipeline-commissioning.md`; no live acceptance is claimed.

2. **Terraform stage 4 (`terraform.plan`) and stage 7 (`terraform.apply`, `root.apply`).** Same gap: no action
   requests `infra.plan`, `infra.apply` or `root.apply`, and their subjects are not defined in this repository.
   `build-candidate` (so `build`) and `infra-apply` fail closed for terraform with that message.
3. **Terraform stage 1.** Formatting, validation and `tofu test` need a pinned, checksum-verified OpenTofu on the
   runner. `security-assurance/policy/tool-registry.yml` has no OpenTofu entry and no checksum could be
   verified offline, so `lint-test` fails closed for terraform. Options: add OpenTofu to the tool registry with
   its published checksums, or run stage 1 inside the deployer image by digest.
4. **Stage 4 image path.** No image build and attest action exists (spec Phase 3). `pipeline.json` accepts an
   `image` recipe, and `config` refuses it until that action exists.
5. **Stage 4 provenance qualification and private sourcemaps.** The staged isolated build job now publishes GitHub provenance for the independently verified digest through a full-SHA-pinned action. Qualify its real Sigstore bundle against the existing authorizer verifier before enrolling that workflow SHA. Private sourcemaps are still not implemented. No provenance requirement was disabled.

6. **ADR-0002 section 1 amendment.** The four required jobs keep their ids and order, but now also need `config`,
   and `security` needs `security-assurance`. The authorizer's evidence check is unchanged (the four names, each
   once, green); the ADR table's "Needs" column should be amended to match.
7. **Coverage thresholds.** 80 percent (`ci-baseline`) and 90 percent (`strict`) of lines are this change's
   choice; the spec names no numbers. They live in `COVERAGE_THRESHOLDS` in `ci/pipeline-config.mjs`.
8. **Stage 5 wording.** Spec 5.6 says "one GitHub-signed squash commit" through the merge API; ADR-0001 and
   ADR-0002 (later, and what the promotion actions implement) fast-forward `main` to a squash candidate built on
   `shadow/pr-<n>`. The pipeline follows the ADRs.
9. **Duplicate run on `main`.** `main` advances by fast-forward to the candidate, so the `main` push reruns
   stages 1 to 4 on a SHA that already passed on `shadow/pr-<n>`, including security-assurance. It keeps release
   bound to a green run of the exact commit; skipping it would need the release to verify the candidate run.
10. **Provenance qualification.** The staged producer exposes no attestation bypass input. Existing authorizer requirements remain unchanged; qualification and a reviewed exact workflow SHA are still required. Private repositories without an eligible GitHub plan fail closed.

11. **infra and its `-root` stacks.** The infra example lists only the `cf-apply` stacks. The `environments/*/
    *-root` stacks apply through `root.apply`; one `pipeline.json` has one apply action. Decide between moving
    them to infra-root or allowing an apply action per stack.
12. **`request-deployment.yml` targets.** Targets must be registered in delivery_control
    `deployment/services.json` (`personal-control` is, and blocked); ProsRUs has none, so its example deploys
    nothing.
13. **Nested `job_workflow_ref` for `release.yml`.** `release.yml` called as `./.github/workflows/release.yml`
    from `pipeline.yml@<sha>` must present `release.yml@<sha>` as its signing identity for `attest-release` to
    pass. VERIFY on the first run on GitHub; it could not be exercised offline.
14. **zizmor `self-repository`.** zizmor 1.30 suggests GitHub's `$/` self-repository syntax for the four `./`
    references (help level, not gated). They stay `./`, as in the existing workflows.

## 5. Develop

```
node --test test/*.test.mjs pipeline/test/*.test.mjs actions/test/*.test.mjs
node pipeline/embed.mjs --check
python3 ci/check-pipeline-orchestration.py
actionlint pipeline/pipeline.yml pipeline/caller.yml
zizmor --offline --no-config pipeline/pipeline.yml pipeline/caller.yml
```
