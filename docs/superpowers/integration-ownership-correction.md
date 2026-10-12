# Integration ownership correction — 2026-10-12

The implementation stays on `feat/fixed-integration-signing`; published checkpoints remain intact.

## Actual corrections

- The eight consumer `build.yml` files contained runner/setup/validation job bodies. Those exact jobs now live in depot-owned `validate-*.yml` reusable workflows. Consumers have only an integration-push trigger, concurrency, permissions and an immutable reusable-workflow reference. Existing application check commands are unchanged.
- `signing_control/cloudflare/integration-runtime.mjs` and the IntegrationRepository/IntegrationActions classes in its Worker were orchestration placed with the signer. They now live in this repository's `src/integration-runtime.mjs` and `src/integration-coordinator-worker.mjs`, with a disabled coordinator configuration. The runtime calls the standalone signer's existing private SourceActions capability, passing repository identity on status lookups. No signing secret or container moved to depot.
- The unused lifecycle vendor copy and integration actor configuration were removed from signing_control. The depot lifecycle is derived from the tested repoctl algorithm at 755028572be78780d4be7d27b14d3aef3db0555a. Repoctl's preexisting source core and delivery mirror remain library/compatibility code; they were not newly deployed consumer signers.
- Accepted authorization policy, webhook/source readers and reusable check orchestration stay in workflow_depot. Conditional ref/PR effects and main advancement stay in delivery_control.
- Per the user's explicit correction, signing_control owns deployment of its own Worker/container directly to Cloudflare. Its documentation no longer requires delivery_control for signer releases. Other delivery ownership is unchanged.

## Runtime wiring

The depot coordinator needs INTEGRATION_SOURCE and SIGNING_CONTROL (the signer's SourceActions entrypoint) private bindings, the numeric repository ID, and the exact commissioned signer configuration digest. It has its own INTEGRATION_STATE durable actor. The webhook's INTEGRATION_RECONCILER binding targets depot's IntegrationActions. All templates remain disabled; no live DO migration or deployment was performed.

## Verification

158 depot tests and 102 signer tests passed after relocation. All eight consumer YAMLs were parsed and verified to contain only the pinned caller job. Their pinned reusable workflow jobs require candidate admission and checkout the exact integration SHA. A structural comparison confirmed the validation job bodies were preserved during relocation. Source checks passed without changing any deployment, credential or provider rule.
