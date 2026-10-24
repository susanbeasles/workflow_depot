# Pipeline integration and commissioning

## Implemented in this change

The installed and staged pipeline copies are identical. The required build check runs on a fresh runner, hashes the immutable same-run artifact, and publishes GitHub provenance for that digest using `actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d`. Candidate scripts still run only in the unprivileged build job. The caller grants the union of job permissions, including `attestations: write`; no permanent credential is introduced.

Stage 7 executes only the pinned depot client. It obtains audience `services.susanb.dev` OIDC credentials, requests `deploy` once, and polls `deploy.status` with a fresh token for each request. Admission, including `ALREADY_CURRENT`, is never accepted as completion. The 30-minute deadline, a terminal failure, rollback, uncertainty, an unexpected response, or an identity mismatch fails the job. A valid success must bind the deployment ID, application, environment, intent, release tag, source commit, release manifest digest, exact target set and nonempty deployed version IDs.

The client implements the existing private handoff: the authorizer issues and hands the one-use grant to the deployer; GitHub receives no grant. Status reads do not mint grants. Admission is never retried after a transport failure, because its outcome may be ambiguous. The validated deployment ID is retained as a step output for reconciliation.

Deployment-enabled `pipeline.json` files must specify `targets.application` and `targets.environment` as well as `targets.deploy` and the application manifest. A target ID is not inferred to be an application. The deploy job declares the corresponding GitHub environment.

An associated Authorizer change rejects an ordinary deployment if the verified release commit differs from the requesting OIDC identity's source SHA, before any grant is minted. The separately privileged rollback path is preserved.

## Observed integration state

These are source and account observations on 2026-10-24, not production acceptance results:

| Component | Inspected revision or observation |
| --- | --- |
| workflow_depot | `5cd0913706d5c6b374f305b6b90ebd7e8525904b` |
| Authorizer | `c145c6d3c8a13ce78df8fac156048263bb163525` |
| Promoter | `1f060deb80b7c0bb799d5f1b5d8eec2aa618e8d8` |
| Deployer | `b9d807e63d8b342b312b1dd6fd86060e2bbe116e` |
| Promotion policy | `promotion_enabled: false`, empty `pipeline_workflow.allowed_shas` |
| Deployment policy | Only the two infrastructure repositories are enrolled; no application deployment enrollment |
| Cloudflare worker inventory | No Workers named `authorizer`, `promoter`, or `deployer`; legacy delivery Workers and `authorizer-setup` exist |
| Cloudflare custom domains | No `services.susanb.dev` custom-domain entry in the returned inventory; zone routes and DNS were not checked |

The legacy services are not assumed to implement the new RPC contracts. Their presence is not proof of commissioning. No bindings, GitHub Apps, credentials, infrastructure resources or signer configuration were changed.

## Contract that must be reconciled before live deployment

The existing release producer and new consumers disagree in more than asset naming. Renaming a file or disabling verification would not resolve this safely.

| Contract | workflow_depot producer | Authorizer/Deployer worker consumers |
| --- | --- | --- |
| Manifest asset | `release.meta.json` | `release.manifest.json` |
| Signature/provenance | `release.zip.sigstore.json`, `release.meta.json.sigstore.json`, Cosign blob signatures | One `attestation.sigstore.json` containing verified subjects for archive and manifest |
| Manifest fields | Includes builder, authorization policy, checksums and target sizes | Strict worker parser rejects those additional fields |
| Supported targets | Worker and D1 migration adapters | New worker parser admits Worker targets only |
| Release immutability | Producer uses write-once draft/upload/publish behavior | Authorizer requires GitHub's returned `immutable: true` |

The infrastructure/runtime owner must agree the canonical release contract and verification mechanism before a cross-service change is commissioned. This change preserves the current producer and does not add competing release storage. Stage 7 intentionally refuses a status digest different from the actual published producer digest.

## Nonsecret runtime handoff

The public request endpoint is `https://services.susanb.dev/v1/token`, with audience `services.susanb.dev` and no redirects. The existing deploy request shape is `{action:"deploy",subject:{application,environment,releaseTag,intent:"deploy"}}`. Its `202` admission must include `status` (`QUEUED` or `ALREADY_CURRENT`), UUIDv7 `deploymentId`, and nullable numeric `githubDeploymentId`.

The existing read shape is `{action:"deploy.status",subject:{application,environment,deploymentId}}`. Its successful response must be the `deployment-state/v1` public projection from the Deployer coordinator. `SUCCEEDED` is accepted only with matching `requestedReleaseTag`, `sourceCommit`, `requestedManifestSha256`, and completed target version IDs. This is authenticated control-plane readback; it does not replace an independent production health/source/artifact probe.

Before enabling a repository, commissioning must establish all of the following:

1. Exact deployed worker identities, private bindings and public endpoint routing.
2. The agreed release format and cryptographic verifier, with a real compatible release fixture.
3. A reviewed full workflow commit allowlisted in both relevant policy systems, with `job_workflow_ref` and `job_workflow_sha` bound to that same SHA.
4. The repository's real numeric ID, application/environment mapping and deployment registry targets.
5. Repository protections and the Promoter's authorized identity, without bypassing checks or relaxing protections.
6. A real candidate artifact attestation verified by the existing Authorizer verifier. Promotion stays disabled until qualification succeeds. Private repositories need a GitHub plan supporting their artifact attestations; unsupported repositories must fail closed.
7. An explicitly approved low-risk production qualification target and exact health/version/source/artifact readback contract.
8. Two ordinary end-to-end releases and real negative authorization/replay tests, with immutable evidence links.

## Work still outstanding

Terraform stage 1, plan/apply orchestration, protected root-approval completion, release-consumer reconciliation, application caller enrollment, promotion enablement and live production qualification remain incomplete. Existing Terraform stages retain their explicit failures; no success is fabricated. The infrastructure runner already retains plans by tree, verifies stored plan digests and checks state expectations, but its live commissioning and pipeline integration have not been qualified here.

Two Terraform protocol gaps require coordination before wiring requests: the current Authorizer accepts plans only from a live PR merge ref and accepts applies only for a commit associated with exactly one merged PR, whereas the pipeline promotes single-parent shadow candidates by fast-forward. Those identities must be qualified together; running an apply against a merely similar tree is not sufficient. A pending root apply returns `awaiting_approval` and a commit, but no job ID or public completion handle; the GitHub job cannot safely claim approved terminal completion through the current `job.status` interface. Root approval must remain independent.

Local verification covers the pipeline structure and client contracts, not live production. The Authorizer deployment test suite uses actual JWT signature verification with ephemeral test keys and in-memory boundaries; it does not prove deployed OIDC routing, deployed policy or Cloudflare resource state.
