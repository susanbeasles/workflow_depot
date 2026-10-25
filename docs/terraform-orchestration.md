# Infrastructure Terraform workflow: controlled commissioning

## Ownership

- `susanbeasles/infra`: owns and maintains **all application infrastructure** via its own OpenTofu executor. The application `deployer` must not execute Terraform jobs, own Terraform state, or hold `CF_APPLY`.
- `susanbeasles/infra-root`: owns foundational infrastructure, trusted policy, protected root state, and the privileged root executor. Any root apply requires independent owner approval via Cloudflare Access.
- `susanbeasles/deployer`: releases verified application code to existing infrastructure only. It cannot create/change queues, databases, routes, Access policies, storage, or other Terraform resources.

Shared, reviewed runner libraries are acceptable; sharing an infrastructure credential or executable endpoint with the application deployer is not. The runtime authority must be split in bindings, permissions, admission policy, and network.

## Code added here

- `actions/request-terraform/main.mjs` validates the numeric identity of `infra` or `infra-root`, the exact PR merge ref or `main` push, and (for plans) the GitHub event's original same-repo PR number. It requests `infra.plan`/`infra.apply` or `root.plan`/`root.apply` from the Authorizer using the job's OIDC token. No Terraform credential enters GitHub.
- It submits an admission **once**. Ambiguous transports are never retried. Read-only `job.status` polling uses a fresh OIDC token each time, enforces job identity, state, commit, stack and result schema, and accepts success only after a terminal verified result, not on acceptance.
- The special `root.apply` response `awaiting_approval` is **not** reported as success: the GitHub job records that owner approval is pending, then fails closed. The existing Authorizer must implement durable post-approval completion evidence before this can become a successful root deployment check.
- `pipeline/terraform.yml` is the staged reusable workflow for GitHub. It checks the executing job's exact `job_workflow_sha` against its immutable `depot_ref` before checking out the code, grants only `contents: read` and `id-token: write`, then calls the OIDC client.
- `pipeline/terraform-caller.yml` is a staged caller for each infrastructure repository; both zero SHAs must be replaced with one reviewed 40-hex commit when installed.

## Non-negotiable commissioning prerequisites

1. **Merge/review and install the pinned reusable workflow** as `.github/workflows/terraform.yml` in `workflow_depot`, and the pinned caller in each infrastructure repository. These are staged files, not live workflows. Installation must respect each repository's AGENTS.md/guard protections.
2. **Commission the infra-owned executor** with its own Worker/container/identity, plan bucket, state encryption key, and least-privilege `CF_PLAN`/`CF_APPLY` and R2 credentials. Route Authorizer `infra.plan`/`infra.apply` and `job.status` to it. The current application Deployer is an unacceptable fallback.
3. **Commission `infra-root` day zero** under independent owner approval: protected buckets, recovery-encrypted state and archives, root plan storage, root credentials and root-runner, with readback and recorded state serial. Never generate a fresh encryption key over an existing state.
4. **Deploy and qualify the Authorizer** with its real read-only GitHub App identity, exact workflow SHA allowlist, and private bindings. An App registration placeholder or source-only PR does not establish deployment.
5. **Reconcile Git commit identity and provenance contracts**. The Authorizer currently expects a PR merge ref for a plan and an actual merged PR commit for applies. The promoter uses a single-parent shadow fast-forward candidate instead. Require exact tree, reviewed saved-plan SHA and state serial, and reject mismatches.
6. **Complete the root approval lifecycle**. After Cloudflare Access approval, produce a durable authenticated job identity/status handle, poll the actual root job, and report a terminal state. Never mark a pending approval as a successful apply.
7. **Qualify state safety and negative tests**: encrypted state, provider pins, approved HCL gate, policy P1-P13 evaluated from protected `infra-root/main`, lock-contention and failure/uncertainty recovery, archive readback, no secret exposure, replay rejection, stale or moved SHA rejection, no unauthorized cross-repo plan/apply.
8. **Do real end-to-end runs**: PR plan, reviewed merge, automated infra apply and root approval, successful state readback and production resource checks; verify no Terraform job ever enters the app Deployer.

This PR provides the OIDC request client and staged workflow/caller, **not** a production-ready pipeline. Do not remove the fail-closed conditions to make checks appear green. See the root and application infrastructure deployment owners before activating.

## Local checks

The client is dependency-free Node and has focused fixture tests in `test/terraform-orchestration.test.mjs`. The source was syntax-checked and its success/refusal flows exercised with isolated mocked authorization responses. The complete repository test suite, cloud runtime and GitHub integration still need independent validation.
