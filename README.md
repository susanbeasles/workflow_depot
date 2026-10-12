# workflow_depot

Personal reusable workflows for repository governance and delivery.

## Central source releases

`.github/workflows/request-release.yml` forwards the calling repository's exact main-push SHA, numeric repository ID, and source run ID to `susanbeasles/delivery_control`. It uses the caller's GitHub context, requires the personal owner's numeric ID, and rejects events other than main pushes. It performs no checkout or source code execution. The receiver independently verifies the source run and history before creating a release.

The source workflow must remain `.github/workflows/auto-release.yml`, which is the receiver's verified push-boundary record. Call the reusable workflow with a reviewed full commit SHA and pass only `RELEASE_DISPATCH_TOKEN`, restricted to Actions write on delivery_control:

```yaml
name: Request official release
on:
  push:
    branches: [main]
permissions: {}
jobs:
  dispatch:
    uses: susanbeasles/workflow_depot/.github/workflows/request-release.yml@REVIEWED_FULL_COMMIT_SHA
    secrets:
      RELEASE_DISPATCH_TOKEN: ${{ secrets.RELEASE_DISPATCH_TOKEN }}
```

Replace the placeholder before installation. workflow_depot is currently public; each caller's Actions policy must allow the pinned workflow. If it is made private through a separate authorized change, its reuse access must cover the selected personal source repositories. Do not change repository visibility or broaden unrelated Actions permissions to enable this caller.

Central release App configuration and per-source dispatch credentials are separate prerequisites. This reusable caller does not configure them or enable immutable releases. Follow delivery_control's `docs/RELEASES.md` for its semver policy, scoped App requirements, retry behavior, and disposable integration drill. Local workflow validation is not evidence of live publication.

GitHub documents that a reusable workflow's GitHub context belongs to the caller: https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations

## Candidate validation

`.github/workflows/validate-controller.yml` validates the exact candidate SHA and runs its controller tests without privileged credentials. `repoctl-source.json` records the original source checkpoint. Existing repository policies govern who may invoke and change these workflows.

## App candidate orchestration (local source, not commissioned)

`.github/workflows/orchestration.yml` defines the native Actions sequence for an exact signed shadow candidate `S`, before main promotion: source-coordinate validation, trusted source admission, app setup, parallel app checks and full scans, the separate shared reviewer, then an aggregate required result. The app caller template is `templates/app-ci.yml`. Replace `REVIEWED_DEPOT_SHA` with the reviewed full depot commit SHA before installing it; no working release pin is claimed for these uncommitted files. The caller runs on pushes to `int/**`, with `github.sha` equal to `S`; it does not test GitHub's synthetic PR merge SHA.

The source admission now calls the existing provenance Worker’s read-only candidate verifier, which checks the private retained candidate proof, enrolled signer, exact shadow ref and current main parent using a pinned GitHub OIDC identity. Generic CI repositories do not need a Cloudflare deployment target; deployment staging still does. The source-owned admission origin, service bindings and enabled policy remain commissioning requirements. No app script may assert admission. No workflow was triggered and no environment artifact was created or uploaded while developing this source.

The deployment provenance verifier currently pins the app caller filename to `.github/workflows/build.yml`; install the thin caller there when integrating that path. The workflow does not yet stage a deployment artifact or invoke the central deployer. Source-owned staging/authorization/execution wiring and immutable workflow pins remain required before activation. CI environment archives and deployable Worker artifacts have different purposes and are not interchangeable.

Each app owns its setup, dependency/cache policy, and CI environment artifact in its own Actions run. `setup:ci` (or another explicitly named `setup:*` package script) must validate its repository-scoped cache and lockfile/platform provenance or perform a clean build. This workflow does not restore a shared cache or claim to validate dependency provenance itself. List only repository-relative environment directories in `environment_paths`, including needed hidden/cache directories explicitly; exclude credentials. The archive is created once, named with repository ID, run ID, attempt, and `S`, with overwrite disabled. Each check compares archive bytes against the SHA-256 output of the setup archive step before extraction. This catches replacement or corruption; it does not turn an app-created environment into trusted scanner or reviewer code. All checks use the exact Node version selected by setup on Ubuntu 24.04. Apps remain responsible for pinning their package manager and runtime dependencies.

Required package scripts are `lint`, `tsc`, `build`, and `test:ci`. The three test suites are `unit`, `integration`, and `e2e`, each with 1–16 shards. The workflow calls `npm run test:ci -- --suite unit --shard-index 1 --shard-count 2`, or `yarn run test:ci --suite unit --shard-index 1 --shard-count 2`. **The app's `test:ci` translates these generic arguments into its framework's real suite and shard flags.** There is no central framework registry. Missing scripts, package managers, setup paths, or failed commands fail the job. Setup and check scripts run as app code with read-only repository permissions, no inherited secrets, and no persisted checkout credential.

Full scans must use the trusted source-owned tools policy, including dependency version/hash integrity, complete hidden/cache/artifact inventory, vulnerability/SCA, SAST, authorized isolated-target DAST/pentest, malware, quality/lint/types/tests, secrets, workflow/IaC, SBOM, IAST, fuzzing, RASP, ASVS/WSTG, and provenance as required by policy. Standard SonarQube rules are mandatory where applicable. Missing or unsupported required tooling, unknown stacks, stale databases, errors, timeouts, incomplete coverage, and skipped gates must block. The job now invokes the trusted local scanner adapters and emits an immutable report only when every required category passes. Actual Gitleaks and Semgrep runs were qualified on owned synthetic fixtures; the full scan policy remains unqualified because several required adapters are unavailable. See [scanner scope and evidence](scanning/README.md) for exact coverage, runtime pins and limitations. The presence of two working adapters does not imply full scan coverage. Dynamic targets must come from trusted source-owned isolated-target policy, never PR-provided URLs.

The shared reviewer is a separate reusable job with a pinned common runtime. Its adapters read exact candidate and baseline code through bounded immutable GitHub raw Contents requests, verify the prior job records and accepted caller workflow bytes, and revalidate the immutable scanner report. The reviewer uses the exact Engineering rules document from the independently located ProsRUs checkpoint and the accepted language/framework/dependency policies. It does not download the app environment or install/run app dependencies. It runs only after all preceding required jobs pass. An independent reviewer identity, accepted policy and authorized review provider are still required; unavailable provider or identity capability cannot emit an approved receipt. No source was sent to a model provider. The final `required` job also rejects skipped or cancelled dependencies; branch protection must require the correct check context when commissioning.

`strategy.fail-fast: false` lets running matrix jobs finish after another fails. Native Actions may also start queued matrix jobs after that failure; this source makes no promise to stop new payload admission. Downstream jobs remain blocked by their dependencies. No custom admission coordinator, failure latch, or service is introduced. Per-app artifacts are distinct from the separately declared Cloudflare deployment artifact store.

## Offline contract tests

Run `node --test test/*.test.mjs` with Node.js 22 or later. The tests execute the actual JavaScript extracted from the reusable release caller with synthetic GitHub context, credentials, and network responses. They check caller rejection, numeric identity limits shared with the receiver, the fixed dispatch destination and exact payload, bounded requests, and failures without automatic retries or credential logging. They also check the candidate workflow's pinned checkout and read-only permissions. No GitHub credentials or network access are used.
