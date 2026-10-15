# ProsRUs delivery contracts (working spec, 2026-10-15)

Derived from `ARTIFACT_DRIVEN_DEPLOYMENT_RFC.md`
(RFC-001) and the existing `workflow_depot/src/shared/contract.mjs` (`worker-artifact/v1`).
All JSON: strict object shapes, unknown keys rejected, canonical JSON (sorted keys, no whitespace) for digests,
size-bounded, duplicate keys rejected. Hex digests are lowercase sha256. Never execute anything found in a bundle.

Naming (fixed):
- application id: `prosrus`; repository `susanbeasles/ProsRUs`, repository id `1412827677`.
- environments: `staging`, `production`.
- Cloudflare resources per environment: Worker script `job-stack-<env>`, D1 `job-stack-<env>`,
  R2 `job-stack-<env>`, Queue `job-stack-<env>` (+ `job-stack-<env>-dlq`), DO class `Coordinator` (same script).
- Product Worker is service-only (no route, no workers.dev). Control (`personal-control`, `control.vespoli.me`)
  reaches it through its `JOB_STACK` service binding → entrypoint `JobStack`. Product reaches Control through
  `CONTROL_AUTHORITY` → `personal-control` entrypoint `JobStackAuthority`.
- Release objects: `releases-r2/prosrus/<releaseTag>/...`; release tags are semver `vMAJOR.MINOR.PATCH`.

## 1. `application-deployment/v1` — lives in the app repo at `deployment/application.json`

```json
{
  "schema": "application-deployment/v1",
  "application": "prosrus",
  "repository": "susanbeasles/ProsRUs",
  "repositoryId": 1412827677,
  "targets": [
    {"id": "prosrus-d1-migrations", "adapter": "cloudflare-d1-migrate/v1",
     "build": {"migrationsDir": "migrations", "binding": "DB"},
     "dependsOn": [], "recoveryPolicy": "forward-only"},
    {"id": "prosrus-worker", "adapter": "cloudflare-worker/v1",
     "build": {"wranglerConfig": "wrangler.jsonc", "entry": "src/worker.ts", "assetsDir": "dist", "buildCommand": "build"},
     "dependsOn": ["prosrus-d1-migrations"], "healthContract": "http-release-marker/v1"}
  ],
  "environments": {
    "staging":    {"allowedRefs": ["refs/heads/main"], "requiredApprovals": 0},
    "production": {"allowedRefs": ["refs/tags/v*"],    "requiredApprovals": 1}
  }
}
```
Rules: target ids `^[a-z0-9-]{1,64}$`, DAG acyclic, adapters only from the fixed set, build paths relative,
normalized, inside the repo, no `..`. `buildCommand` names an npm script; it is never a shell string.

## 2. Bundles produced by Build

`targets/worker.zip` (one per `cloudflare-worker/v1` target):
```
artifact.json            worker-artifact/v2 (below) — module content inline, asset BYTES not inline
assets/<path>            static files, normalized relative paths, regular files only
```
`worker-artifact/v2`:
```json
{
  "schema": "workflow-depot-worker-artifact/v2",
  "metadata": {
    "main_module": "worker.mjs",
    "compatibility_date": "2026-10-08",
    "compatibility_flags": ["nodejs_compat"],
    "bindings": [ /* v1 types: inherit|plain_text|r2_bucket|d1|kv_namespace|service|durable_object_namespace
                     v2 adds: {"name","type":"assets"}, {"name","type":"queue","queue_name"},
                     and durable_object_namespace MAY use {"class_name"} (same-script) instead of namespace_id */ ],
    "migrations": {"new_tag": "v1", "new_sqlite_classes": ["Coordinator"]},   // optional, DO migrations only
    "assets": {"config": {"not_found_handling": "single-page-application", "run_worker_first": true},
               "manifest": [{"path": "index.html", "sha256": "…", "sizeBytes": 1, "contentType": "text/html"}]}
  },
  "modules": [{"name": "worker.mjs", "type": "esm", "content": "…"}]
}
```
Limits: module ≤ 5 MiB, assets ≤ 20,000 files / 25 MiB each / 100 MiB total, paths `^[A-Za-z0-9._~/-]+$`, no `..`.
Resource ids in bindings (database_id, bucket_name, queue_name, service) are **claims**; the deployer resolves
the real ids from the Terraform registry (§7) and rejects mismatches. Secrets are `inherit` only.

`targets/migrations.zip`:
```
ledger.json              migrations-ledger/v1
NNNN_name.sql            exact bytes from the repo
```
`migrations-ledger/v1`: `{"schema","binding":"DB","migrations":[{"version":"0001","file":"0001.sql","sha256","sizeBytes",
"statements":<int>,"compatibility":"additive|expand|contract","recoveryPolicy":"forward-only"}]}` — ordered, versions strictly
increasing, every file in the dir listed, `compatibility` from a leading `-- compatibility: additive` comment, default `additive`;
`contract` requires `-- requires: <version>` naming the expand it follows.

## 3. `release-manifest/v2` (RFC 4.2) — `release.meta.json`
```json
{
  "schema": "release-manifest/v2",
  "application": "prosrus",
  "repository": "susanbeasles/ProsRUs",
  "repositoryId": 1412827677,
  "releaseTag": "v1.0.0",
  "sourceCommit": "<40-hex>",
  "createdAt": "2026-10-15T00:00:00Z",
  "builder": {"workflow": "susanbeasles/workflow_depot/.github/workflows/release.yml@<40-hex>", "runId": "…", "runAttempt": "1"},
  "artifact": {"path": "release.zip", "sha256": "…", "sizeBytes": 1, "mediaType": "application/zip"},
  "targets": [
    {"id": "prosrus-d1-migrations", "adapter": "cloudflare-d1-migrate/v1", "artifactPath": "targets/migrations.zip",
     "sha256": "…", "sizeBytes": 1, "dependsOn": [], "recoveryPolicy": "forward-only"},
    {"id": "prosrus-worker", "adapter": "cloudflare-worker/v1", "artifactPath": "targets/worker.zip",
     "sha256": "…", "sizeBytes": 1, "dependsOn": ["prosrus-d1-migrations"], "healthContract": "http-release-marker/v1"}
  ],
  "authorizationPolicy": {"path": "authorization-policy.json", "sha256": "…"},
  "checksums": {"path": "checksums.json", "sha256": "…"}
}
```
`release.zip` contains: `release.meta.json`? NO — the manifest describes the zip and is stored beside it.
`release.zip` = `targets/*.zip` + `authorization-policy.json` + `checksums.json` + `sbom.cdx.json` (if produced).
Manifest digest = sha256(canonical JSON of the manifest). `release.sig` = cosign bundle over `release.meta.json`.

## 4. `authorization-policy/v1` — `authorization-policy.json`
Produced by Build from `deployment/application.json` + workflow identity; consumed by admission (other agent).
```json
{
  "schema": "authorization-policy/v1",
  "policyVersion": 1,
  "application": "prosrus",
  "repository": "susanbeasles/ProsRUs",
  "repositoryId": 1412827677,
  "releasePrefix": "prosrus/",
  "sourceCommit": "<40-hex>",
  "releaseTag": "v1.0.0",
  "signer": {"issuer": "https://token.actions.githubusercontent.com",
             "identity": "https://github.com/susanbeasles/workflow_depot/.github/workflows/release.yml@<40-hex>"},
  "environments": {
    "staging":    {"allowedRefs": ["refs/heads/main"], "requiredApprovals": 0, "targets": ["prosrus-d1-migrations","prosrus-worker"]},
    "production": {"allowedRefs": ["refs/tags/v*"],    "requiredApprovals": 1, "targets": ["prosrus-d1-migrations","prosrus-worker"]}
  },
  "expiresAt": "2027-10-15T00:00:00Z"
}
```

## 5. `release-checksums/v1` — `checksums.json` (+ `SHA256SUMS` text, same content)
`{"schema":"release-checksums/v1","algorithm":"sha256","files":{"targets/worker.zip":{"sha256","sizeBytes"}, … }}`
Covers every bundle, `authorization-policy.json`, `sbom.cdx.json`; computed once, verified again before signing and before publish.

## 6. `promotion-request/v1` (RFC 4.1) — built by the Deploy phase, POSTed with a GitHub OIDC token
```json
{"schema":"promotion-request/v1","requestId":"<uuid v7>","application":"prosrus","environment":"staging",
 "repository":"susanbeasles/ProsRUs","releaseTag":"v1.0.0",
 "releaseManifestUri":"r2://releases-r2/prosrus/v1.0.0/release.meta.json","releaseManifestSha256":"…",
 "expectedCurrentGeneration":17,"githubDeploymentId":123,"requestedAt":"…"}
```
The admission Worker URL and audience come from workflow inputs sourced from the Terraform registry; never from the bundle.

## 7. `application-registry/v1` — Terraform output (infra repo), consumed by the deployer
```json
{"schema":"application-registry/v1","application":"prosrus","environment":"staging",
 "repository":"susanbeasles/ProsRUs","repositoryId":1412827677,"accountId":"<32-hex>","releasePrefix":"prosrus/",
 "targets":{
   "prosrus-worker":{"adapter":"cloudflare-worker/v1","scriptName":"job-stack-staging","ingress":{"type":"service-only"},
                     "bindings":{"DB":{"type":"d1","database_id":"<uuid>"},"ARTIFACTS":{"type":"r2_bucket","bucket_name":"job-stack-staging"},
                                 "JOBS":{"type":"queue","queue_name":"job-stack-staging"},
                                 "CONTROL_AUTHORITY":{"type":"service","service":"personal-control","entrypoint":"JobStackAuthority"}}},
   "prosrus-d1-migrations":{"adapter":"cloudflare-d1-migrate/v1","databaseId":"<uuid>","binding":"DB"}}}
```

## 8. `http-release-marker/v1` — health contract implemented by the app
- Product Worker default `fetch`: `GET /.well-known/release-marker` → 200 `application/json`
  `{"schema":"release-marker/v1","application":"prosrus","releaseTag","sourceCommit","artifactSha256","startedAt"}`;
  every other path stays 404. No data, no auth, no cookies, `cache-control: no-store`.
- Same payload from the `JobStack` entrypoint RPC `releaseMarker()` for service-only checks.
- Values are injected at build time into `release-marker.json` imported by the worker (plain_text binding
  `RELEASE_MARKER` is also acceptable); never computed from env at runtime.

## 9. Release phase sequence (universal `release.yml`, workflow_depot)
resolve-release-context → verify-source (signed tag/commit matches) → build-worker-bundle (per worker target)
→ bundle-migrations → write-authorization-policy → checksum-bundles → assemble-release (release.zip)
→ write-release-manifest → verify-release (independent re-check of every digest, zip hygiene: no symlinks,
no absolute/`..` paths, bomb ratio ≤ 100×, ≤ 20k entries) → attest-release (cosign sign-blob OIDC +
`actions/attest-build-provenance`) → publish-release (GitHub Release assets, write-once: fail if tag release exists)
→ publish-release-objects (R2, `If-None-Match: *` on every key; temp key then finalize `release.meta.json` last).
Each step is one composite action in `workflow_depot/.github/actions/<name>/action.yml`, single concern,
inputs/outputs only, no secrets except the publish steps, all `uses:` pinned to 40-hex SHAs.
