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
