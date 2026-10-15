# Release pipeline (stage 6)

`.github/workflows/release.yml` is the universal, reusable release workflow. An application
pipeline calls it after its quality, security and promotion gates; it turns the exact pushed
commit into a signed, write-once GitHub Release that the deployer consumes by tag. It is
composed only of this repository's single-concern composite actions in `.github/actions/`,
which call the scripts in `ci/release/`. Contracts are in [contracts.md](contracts.md).

```
bundle (contents: read)
  compute-release-version -> resolve-release-context -> read-application-manifest
  -> build-worker-bundle -> bundle-migrations -> write-authorization-policy -> generate-sbom
  -> checksum-bundles -> assemble-release -> write-release-manifest -> verify-release (unsigned)
attest (contents: read, id-token: write, attestations: write)
  verify-release (unsigned) -> attest-release
publish (contents: write)
  verify-release (signed) -> publish-github-release
publish-objects (contents: read; only when r2_account_id and r2_bucket are set)
  verify-release (signed) -> publish-release-objects
```

## Calling release.yml

```yaml
jobs:
  release:
    needs: [promotion-gate]            # whatever precedes release in the caller
    permissions:
      contents: write                  # publish job: GitHub Release
      id-token: write                  # attest job: keyless signing
      attestations: write              # attest job: build provenance
    uses: susanbeasles/workflow_depot/.github/workflows/release.yml@REVIEWED_DEPOT_SHA
    with:
      depot_ref: REVIEWED_DEPOT_SHA    # must equal the SHA in `uses:`
      # application_manifest: deployment/application.json
      # r2_account_id: <32-hex account id>   # optional; empty skips R2
      # r2_bucket: releases-r2               # optional; empty skips R2
    secrets:                           # only when R2 publication is enabled; never `inherit`
      R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
      R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

The caller workflow must run on `push` to `refs/heads/main` or to a `vX.Y.Z` tag. The caller job
grants the union of the permissions the reusable jobs declare; each job then keeps only its own.

| Input | Default | Meaning |
|---|---|---|
| `depot_ref` | required | Full 40-hex commit of `susanbeasles/workflow_depot`. Must be the SHA in `uses:` (see Verifying). |
| `application_manifest` | `deployment/application.json` | `application-deployment/v1` path in the calling repository. |
| `r2_account_id` | `''` | Cloudflare account id for optional R2 publication. |
| `r2_bucket` | `''` | Release bucket for optional R2 publication. |

Secrets (names only, both optional, used only by `publish-objects`): `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`. Outputs: `released` (`'true'`/`'false'`), `releaseTag`, `manifestSha256`.

## Versioning and tags

- `refs/heads/main` push: `ci/release/next-version.mjs` computes the next version from Conventional
  Commits since the highest `vX.Y.Z` tag reachable from the commit: `feat` -> minor, `fix`/`perf` ->
  patch, `!` or a `BREAKING CHANGE:` footer -> major; anything else does not release. With no
  previous tag the base is `v0.0.0`. No releasable commit => `released=false`, the workflow
  succeeds, and attest/publish are skipped. The tag is created by the GitHub Release API at the exact
  commit (`target_commitish`); an existing tag or release fails the run.
- `refs/tags/vX.Y.Z` push: the tag must resolve to `github.sha`; an existing release fails the run.
- Any other event or ref fails closed. There is no prerelease path.

## Release assets

Published on the GitHub Release (exact names):

| Asset | Content |
|---|---|
| `release.zip` | `targets/*.zip`, `authorization-policy.json`, `checksums.json`, `sbom.cdx.json`, `sbom.spdx.json` |
| `release.zip.sigstore.json` | cosign `sign-blob` bundle over `release.zip` |
| `release.meta.json` | `release-manifest/v2` (canonical JSON; its sha256 is the manifest digest) |
| `release.meta.json.sigstore.json` | cosign `sign-blob` bundle over `release.meta.json` |
| `release.zip.intoto.jsonl` | `actions/attest-build-provenance` bundle (`bundle-path`) for `release.zip` |
| `sbom.cdx.json`, `sbom.spdx.json` | CycloneDX / SPDX from syft over the unpacked bundles |
| `checksums.json`, `SHA256SUMS` | `release-checksums/v1` and the same digests as text |
| `authorization-policy.json` | `authorization-policy/v1` consumed by admission |

Every `targets/*.zip` additionally gets its own provenance attestation in the repository's
attestation store, so per-target digests verify with `gh attestation verify`.

Bundles: `targets/worker.zip` holds `artifact.json` (`workflow-depot-worker-artifact/v2`, module
inline, asset digests only) and `assets/<path>`; `targets/migrations.zip` holds `ledger.json`
(`migrations-ledger/v1`) and the SQL files byte-for-byte. One target per adapter is supported.

## Verifying a release

The signatures are keyless. Inside a reusable workflow the Fulcio certificate identity is the
job's `job_workflow_ref`, which `release.meta.json` records as `builder.workflow`:

```
builder.workflow     = susanbeasles/workflow_depot/.github/workflows/release.yml@<DEPOT_SHA>
certificate identity = https://github.com/susanbeasles/workflow_depot/.github/workflows/release.yml@<DEPOT_SHA>
issuer               = https://token.actions.githubusercontent.com
```

`<DEPOT_SHA>` is the SHA the caller pinned in `uses:`. `attest-release` signs and then runs
`cosign verify-blob` against `https://github.com/<builder.workflow>`; if `depot_ref` differs from the
pinned SHA, that verification fails and nothing is published. `authorization-policy.json` carries the
same identity in `signer.identity`. A consumer (for example the deployer's `worker.deploy.<target>`)
runs, for repository `OWNER/APP`, tag `vX.Y.Z` and the reviewed `DEPOT_SHA`:

```sh
gh release download vX.Y.Z --repo OWNER/APP --dir release
cd release
IDENTITY="https://github.com/susanbeasles/workflow_depot/.github/workflows/release.yml@${DEPOT_SHA}"
ISSUER="https://token.actions.githubusercontent.com"

cosign verify-blob --bundle release.zip.sigstore.json \
  --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" release.zip
cosign verify-blob --bundle release.meta.json.sigstore.json \
  --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" release.meta.json
cosign verify-blob-attestation --bundle release.zip.intoto.jsonl --new-bundle-format \
  --type slsaprovenance1 \
  --certificate-identity "$IDENTITY" --certificate-oidc-issuer "$ISSUER" release.zip
gh attestation verify release.zip --repo OWNER/APP \
  --bundle release.zip.intoto.jsonl --cert-identity "$IDENTITY" --cert-oidc-issuer "$ISSUER"

# Structural re-verification with the depot at the same SHA (bundles are read from release.zip):
node /path/to/workflow_depot/ci/release/verify-release.mjs --release-dir . --stage signed --layout published
```

Then check that `release.meta.json` names the expected `repository`, `repositoryId`, `releaseTag`
and `sourceCommit`, and use `targets[].sha256` (equal to `checksums.json`) for each bundle. Per-target
provenance: extract a bundle from `release.zip` and run
`gh attestation verify targets/worker.zip --repo OWNER/APP --cert-identity "$IDENTITY" --cert-oidc-issuer "$ISSUER"`.
The cosign and `gh` flags above follow cosign v2.4+/v3 and current `gh`; confirm them against the
installed versions when commissioning, since they could not be exercised offline here.

## Composite actions

| Action | Concern |
|---|---|
| `compute-release-version` | `git log` since the last tag -> `released`, `release_tag`; verifies tag pushes point at the commit. |
| `resolve-release-context` | Binds repository, numeric repository id, commit, ref and run to the tag (`release-context/v1`). |
| `read-application-manifest` | Validates `application-deployment/v1` (strict keys, acyclic DAG, fixed adapters, normalized paths) and checks it names the calling repository. |
| `build-worker-bundle` | `npm ci --ignore-scripts`, optional `scripts/write-release-marker.mjs <tag> <sha> <64 zeros>`, `npm run <buildCommand>`, `npx --no-install wrangler deploy --dry-run --outdir`, all with `env -i` (PATH, HOME, CI only); then packages `targets/worker.zip`. Rejects symlinks, special files, paths outside the app, extra modules and over-limit sizes. |
| `bundle-migrations` | `targets/migrations.zip` + ledger; header directives `-- compatibility:` / `-- requires:`; every file in the directory must be a listed migration. |
| `write-authorization-policy` | `authorization-policy.json`; expiry = source commit time + 365 days. |
| `generate-sbom` | Strict unpack of the bundles, then syft (installed and digest-checked by `security-assurance`'s `install-tool`). |
| `checksum-bundles` | `checksums.json` + `SHA256SUMS`; stray files fail. |
| `assemble-release` | Re-verifies checksums, writes deterministic `release.zip`. |
| `write-release-manifest` | `release.meta.json` with `builder.workflow = <depot>/.github/workflows/release.yml@<depot_ref>`. |
| `verify-release` | Independent re-check of every digest, ZIP hygiene and cross-document consistency. Runs before signing and again before each publication. |
| `attest-release` | cosign `sign-blob` + `verify-blob` (pinned `sigstore/cosign-installer`), `actions/attest-build-provenance` for `release.zip` and `targets/*.zip`. |
| `publish-github-release` | Write-once Release: refuse existing release/tag, draft at the exact commit, upload ten assets (checking name, size and digest), recheck tag, publish, confirm tag target. |
| `publish-release-objects` | Optional R2 copy at `<bucket>/<application>/<tag>/`: SigV4 (`ci/release/sigv4.mjs`), `If-None-Match: *` on every PUT, `release.meta.json` last. |
| `submit-promotion-request` | Deploy-stage helper (not wired into `release.yml`): builds `promotion-request/v1` (UUIDv7) and POSTs it once with a GitHub OIDC token; https only, redirects are errors, prints only status and requestId. Inputs: `manifest_path`, `admission_url`, `admission_audience`, `environment`, `release_bucket`, `expected_generation`, `github_deployment_id`; needs `id-token: write`. |

## Design decisions

- **Reproducible bundles.** Entries are sorted, timestamps fixed to 1980-01-01, external attributes
  zero, and entries are stored (not deflated) so bytes do not depend on the zlib build. Worker and
  migrations bundles are byte-identical across builds of the same input (tested). `release.zip` is
  reproducible when the SBOMs are (syft output may embed run-specific fields).
- **Canonical JSON files.** Every JSON document the pipeline writes is canonical JSON with no
  trailing newline, so `sha256(file)` equals the canonical digest; verifiers reject non-canonical bytes
  and duplicate keys.
- **Release marker.** The module digest is unknown before bundling, so the app's optional
  `release-marker.json` gets a 64-zero placeholder and the authoritative marker is the `RELEASE_MARKER`
  `plain_text` binding (canonical `release-marker/v1` without `startedAt`), where `artifactSha256` is the
  sha256 of the bundled `worker.mjs`. The v2 validator checks that digest; `verify-release` checks the
  marker against the manifest.
- **Bindings are claims.** `vars` become `plain_text`, D1/R2/KV/service/queue/DO bindings keep the
  wrangler ids, and the deployer re-resolves them against the Terraform registry. Wrangler keys owned by
  Terraform or the deployer (routes, `env`, cron triggers, queue consumers, custom `build`, cross-script
  DOs, R2 jurisdictions, unknown keys) fail the build; `workers_dev`, `preview_urls` and `observability`
  are ignored.
- **Write-once.** GitHub: draft-then-publish so `GET /releases/tags/{tag}` never shows a partial asset
  set; a failure after the draft leaves it for an operator (never auto-deleted). R2: `412` on any key
  stops publication; partial uploads without `release.meta.json` are unreachable. Re-running a failed
  release after publication fails by design.
- **Credentials.** No bundle, manifest, policy or log contains credentials. Only `publish-objects`
  receives secrets; `publish-github-release` uses the job token from the environment (never argv).

## Deliberately not done

- No deployment, no `wrangler deploy`/`versions upload`, no Cloudflare API tokens, no Terraform.
- `submit-promotion-request` is not wired: the deploy stage (owned by `pipeline.yml`) supplies the
  admission URL/audience from the Terraform registry, the current generation and the GitHub Deployment id.
- Source signature verification (`verify-source` in contracts §9) is not implemented; tag pushes are
  checked to point at the commit, but tag/commit signatures are not verified.
- Not supported (fails closed): more than one target per adapter, multi-step Durable Object migrations,
  `wrangler.toml`, JSON `vars`, additional modules (wasm, chunks), `.assetsignore`/`_headers`/`_redirects`.
- Secrets are not inferred: wrangler config has no secret list, so the artifact carries no `inherit`
  bindings; the deployer must keep existing secret bindings.
- The SBOM covers the release payload; bundled JavaScript without package manifests yields sparse
  component lists (syft's documented blind spot).
- Artifact attestations for private repositories depend on the GitHub plan; check before commissioning.
