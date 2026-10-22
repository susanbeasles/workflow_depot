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
     "dependsOn": ["prosrus-d1-migrations"], "healthContract": "http-release-marker/v1"},
    {"id": "prosrus-replicator", "adapter": "cloudflare-worker/v1",
     "build": {"wranglerConfig": "wrangler.replicator.jsonc", "entry": "src/replicator/worker.ts"},
     "dependsOn": ["prosrus-d1-migrations"], "healthContract": "worker-version/v1"}
  ],
  "environments": {
    "staging":    {"allowedRefs": ["refs/heads/main"], "requiredApprovals": 0},
    "production": {"allowedRefs": ["refs/tags/v*"],    "requiredApprovals": 1}
  }
}
```
Rules: target ids `^[a-z0-9-]{1,64}$`, DAG acyclic, adapters only from the fixed set, build paths relative,
normalized, inside the repo, no `..`. `buildCommand` names an npm script; it is never a shell string.
Any number of targets per adapter; each is bundled at `targets/<target-id>.zip`. Worker targets may omit `assetsDir`
and `buildCommand` (no assets, no npm build). `healthContract` is `http-release-marker/v1` (§8) or `worker-version/v1`
(routeless Worker: no route, `workers_dev: false`, no assets; the deployer proves the release by the active deployed
version, not HTTP). Release manifest and authorization policy record the contract per target.

## 2. Bundles produced by Build

`targets/<target-id>.zip` for each `cloudflare-worker/v1` target (e.g. `targets/prosrus-worker.zip`):
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
               "manifest": [{"path": "index.html", "sha256": "…", "sizeBytes": 1, "contentType": "text/html"}]},
    "declared": {"crons": ["*/5 * * * *"],                                      // optional; infrastructure-owned
                 "queueConsumers": [{"queue": "…", "maxBatchSize": 10, "maxRetries": 5, "deadLetterQueue": "…"}]}
  },
  "modules": [{"name": "worker.mjs", "type": "esm", "content": "…"}]
}
```
Limits: module ≤ 5 MiB, assets ≤ 20,000 files / 25 MiB each / 100 MiB total, paths `^[A-Za-z0-9._~/-]+$`, no `..`.
Resource ids in bindings (database_id, bucket_name, queue_name, service) are **claims**; the deployer resolves
the real ids from the Terraform registry (§7) and rejects mismatches. Secrets are `inherit` only: wrangler
`secrets_store_secrets: [{binding, store_id, secret_name}]` becomes `{"name": binding, "type": "inherit"}` (store_id and
secret_name are not carried; the root path owns that binding). `declared` records wrangler `triggers.crons` and
`queues.consumers` so the deployer can compare them with the registry; it is never authority. Queue producers are
`queue` bindings. Every worker bundle carries its own `RELEASE_MARKER` (§8) whose `artifactSha256` is its `worker.mjs` digest.

`targets/<target-id>.zip` for each `cloudflare-d1-migrate/v1` target (e.g. `targets/prosrus-d1-migrations.zip`):
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
    {"id": "prosrus-d1-migrations", "adapter": "cloudflare-d1-migrate/v1", "artifactPath": "targets/prosrus-d1-migrations.zip",
     "sha256": "…", "sizeBytes": 1, "dependsOn": [], "recoveryPolicy": "forward-only"},
    {"id": "prosrus-worker", "adapter": "cloudflare-worker/v1", "artifactPath": "targets/prosrus-worker.zip",
     "sha256": "…", "sizeBytes": 1, "dependsOn": ["prosrus-d1-migrations"], "healthContract": "http-release-marker/v1"},
    {"id": "prosrus-replicator", "adapter": "cloudflare-worker/v1", "artifactPath": "targets/prosrus-replicator.zip",
     "sha256": "…", "sizeBytes": 1, "dependsOn": ["prosrus-d1-migrations"], "healthContract": "worker-version/v1"}
  ],
  "authorizationPolicy": {"path": "authorization-policy.json", "sha256": "…"},
  "checksums": {"path": "checksums.json", "sha256": "…"}
}
```
`release.zip` contains: `release.meta.json`? NO — the manifest describes the zip and is stored beside it.
`release.zip` = `targets/*.zip` + `authorization-policy.json` + `checksums.json` + `sbom.cdx.json`/`sbom.spdx.json` (if produced).
Manifest digest = sha256(canonical JSON of the manifest). `release.meta.json.sigstore.json` and `release.zip.sigstore.json`
are the cosign bundles (published beside them; this replaces the earlier `release.sig` name).

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
  "targets": {
    "prosrus-d1-migrations": {"adapter": "cloudflare-d1-migrate/v1", "recoveryPolicy": "forward-only"},
    "prosrus-worker":        {"adapter": "cloudflare-worker/v1", "healthContract": "http-release-marker/v1"},
    "prosrus-replicator":    {"adapter": "cloudflare-worker/v1", "healthContract": "worker-version/v1"}
  },
  "environments": {
    "staging":    {"allowedRefs": ["refs/heads/main"], "requiredApprovals": 0, "targets": ["prosrus-d1-migrations","prosrus-worker","prosrus-replicator"]},
    "production": {"allowedRefs": ["refs/tags/v*"],    "requiredApprovals": 1, "targets": ["prosrus-d1-migrations","prosrus-worker","prosrus-replicator"]}
  },
  "expiresAt": "2027-10-15T00:00:00Z"
}
```

## 5. `release-checksums/v1` — `checksums.json` (+ `SHA256SUMS` text, same content)
`{"schema":"release-checksums/v1","algorithm":"sha256","files":{"targets/prosrus-worker.zip":{"sha256","sizeBytes"}, … }}`
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
no absolute/`..` paths, bomb ratio ≤ 100×, ≤ 20k entries) → attest-release (cosign sign-blob OIDC; no GitHub
artifact attestations) → publish-release (GitHub Release assets, write-once: fail if tag release exists)
→ publish-release-objects (R2, `If-None-Match: *` on every key; temp key then finalize `release.meta.json` last).
Each step is one composite action in `workflow_depot/.github/actions/<name>/action.yml`, single concern,
inputs/outputs only, no secrets except the publish steps, all `uses:` pinned to 40-hex SHAs.

## 10. Recovery and backup (owner decisions, 2026-10-15) — binding

Capture: every committed change is an immutable hash-chained `recovery_transactions` row plus its `recovery_outbox`
job, written in the SAME D1 batch (existing maintained save path). Writes that bypass this path are not allowed.
Files are immutable content-addressed originals (sha256); only new content is copied; no binary diffs.

Storage per environment (Terraform root stack):
- `job-stack-<env>-uploads`  temporary upload chunks; lifecycle deletes objects after 7 days, aborts multipart after 1 day; NO lock.
- `job-stack-<env>-originals` retained originals; prefix lock `blobs/` Age 30 days (time-bounded); no lifecycle delete.
  Current originals are preserved while their records remain active; deletion only via a reviewed retention operation.
- `job-stack-<env>-backup`   independent destination; bound ONLY to the replicator Worker (Product has no binding).
  Layout and protection:
    changes/<workspaceId>/<sequence 20-digit zero-padded>-<transactionDigest>.json   lock Age 30d,  lifecycle delete 31d
    receipts/<workspaceId>/<sequence 20-digit>.json                                   lock Age 30d,  lifecycle delete 31d
    checkpoints/daily/<workspaceId>/<YYYY-MM-DD>/manifest.json (+ tables/<table>.ndjson) lock Age 90d,  lifecycle delete 91d
    checkpoints/monthly/<workspaceId>/<YYYY-MM>/manifest.json  (+ tables/<table>.ndjson) lock Age 365d, lifecycle delete 366d
    objects/sha256/<first 2 hex>/<sha256>                                             lock Age 365d, NO lifecycle;
      garbage-collected by the replicator only when unreferenced by every retained checkpoint, every retained change
      and every current original, and only after its lock has expired.
  Every put is conditional create-only; an existing object with the same digest is "matched_existing", a different digest is a fault.

Replicator Worker `job-stack-<env>-replicator` (separate identity, same repo, `src/replicator/`, `wrangler.replicator.jsonc`):
bindings DB, ORIGINALS (read), BACKUP (write), JOBS queue consumer (wake-ups; at-least-once), crons:
`*/5 * * * *` sweep due outbox jobs (covers lost messages), `23 3 * * *` daily checkpoint + GC, monthly checkpoint on day 1.
Ordered per workspace: transaction N is replicated and verified only after N-1 has a receipt. Lease/fence from the existing
outbox; duplicate delivery and crash-after-put are idempotent (matched_existing, one receipt).

`recovery-checkpoint/v1` manifest: {schema, checkpointId, kind daily|monthly, workspace {ownerId, workspaceId},
position {epochId, sequence, transactionDigest}, schemaVersion (latest applied D1 migration version), tables:[{name,
objectKey, sha256, rows}], files:[{sha256, sizeBytes, objectKey}], previousCheckpointId|null, createdAt}; manifest digest =
sha256(canonical JSON). A checkpoint is "verified" only after every table and file object is read back and re-hashed.
Recorded in D1 table `recovery_checkpoints` (append-only, immutable triggers).

Restore (operator procedure, never in-place): choose newest retained verified checkpoint ≤ target → load tables into a NEW
D1 database at the checkpoint's schema version → replay changes in sequence order verifying previous_digest linkage up to the
target → verify every referenced file in backup objects/ (re-hash) and copy to a new originals bucket → emit restore report.
Changes recorded under a newer schema version than the restore database are replayed only after the matching migrations apply.

Read operation `job_stack_recovery_status` (effect read, scope `job-stack.protection.read`, owner-json + mcp), input
`{workspaceId}`, output `recovery-status-v1`:
{format:'recovery-status-v1', workspaceId,
 state:'protected'|'protection_pending'|'delayed'|'degraded'|'failed'|'unavailable',
 head:{sequence, committedAt}|null,
 latestVerified:{sequence, transactionDigest, verifiedAt}|null,
 latestCheckpoint:{checkpointId, kind, position:{sequence}, verifiedAt}|null,
 lag:{pendingTransactions, oldestPendingAt|null, seconds|null},
 deadLetters, observedAt}
`protected` ONLY when latestVerified.sequence == head.sequence AND a verified checkpoint exists within 26h; pending work is
`protection_pending` (lag ≤ 15 min) or `delayed` (> 15 min); dead letters → `failed`; never label pending as protected.
D1 Time Travel is an additional platform layer, not independent protection, and is never reported as `protected`.

## 11. Infrastructure state (owner decisions) — binding
Dedicated `tf-state` bucket separate from application storage; backend with verified locking (`use_lockfile = true`);
OpenTofu state encryption (key from Secrets Store `TF_ENCRYPTION_INFRA`, supplied via `TF_ENCRYPTION`, never in Git);
before each apply the deployer archives the current state with lineage/serial, source commit, tool/provider versions and the
reviewed plan digest to an independent destination under unique names; the live state object is never locked.
State, saved plans and credentials never enter Git. Restoring state changes Terraform's record, not reality: reconcile
against actual resources and review the plan before any apply. Recovery chain: restore configuration → recover/reconcile
state → recover infrastructure as needed → restore application data. New environments pin OpenTofu `= 1.10.6`.
Workers and buckets are created/adopted by the root provisioning path; `cf-apply` restrictions stay intact.
