# workflow_depo

One repo that owns the agent control plane and pushes it everywhere. Change a hook here,
every repo gets a PR. A nightly job writes `STATUS.md`: which repos have what version,
which drifted, which still have no branch protection.

```
packs/agent-guard/          the pack (see its MANIFEST: managed vs seeded files)
repos.yml                   which repos are managed
scripts/sync.sh             apply packs to every repo, open/update one PR per repo
scripts/status.sh           state of affairs -> STATUS.md + state/status.json
scripts/bootstrap.sh        one-time: create the repo, push, tag v1, explain the token
.github/workflows/guard.yml       reusable CI gate every repo calls (@v1)
.github/workflows/distribute.yml  runs sync on pack changes / on demand
.github/workflows/status.yml      nightly status
```

## Setup (once)

```
scripts/bootstrap.sh          # creates private repo, pushes, tags v1, prints token instructions
```

Then create the fine-grained PAT it describes and store it as `WORKFLOW_DEPO_TOKEN`.
Run `distribute` with `dry_run=true` first; it prints what would change in each repo.

## How distribution works

- `repos.yml`: empty `include` = every non-archived, non-fork repo you own, minus `exclude`.
- Each pack has a `MANIFEST`. **managed** files are overwritten on every sync and reported as
  drift if edited in-repo. **seeded** files (`allowed-hosts`, the two check scripts, `AGENTS.md`,
  `CLAUDE.md`, pre-commit config) are created once and then belong to that repo.
- Sync never pushes to `main`. It force-pushes a single branch `chore/workflow-depo-sync` and
  opens or updates one PR per repo. Merge with **squash** in the UI: GitHub signs that merge
  commit, so "require signed commits" on `main` is satisfied without giving CI a signing key.
- The per-repo workflow is a 10-line caller of `guard.yml@v1` here. CI logic changes don't need
  a re-sync; move the `v1` tag (or cut `v2` and bump the caller in the pack).
- `__OWNER__` in pack files is rendered to your GitHub login on the way out.

## Releasing a pack change

1. Edit `packs/agent-guard/...`.
2. Bump `packs/agent-guard/VERSION` **and** `packs/agent-guard/.guard/VERSION` (same value).
3. Merge to `main`. `distribute` runs, PRs appear, `STATUS.md` refreshes.

## State of affairs

`STATUS.md` columns: visibility · installed version · state (`ok` / `stale` / `drift(n)` /
`missing`) · open sync PR · branch protection (`protected` / `none` / `plan-blocked` = private
repo on a plan that doesn't allow it) + ruleset count · secret scanning / push protection.
`state/status.json` has the same data for scripting.

## Limits

- The PAT is the blast radius. Scope it to the repos you manage and rotate it; it lives only in
  this repo's secrets. A GitHub App is the cleaner answer if this ever stops being solo.
- Sync commits are unsigned (made by CI). That's fine as long as they land via squash-merge in
  the UI; a `git merge` from your terminal would carry the unsigned commit onto `main`.
- Drift detection is byte-exact on managed files. If you *want* a repo-local change to a hook,
  that's a signal to make it configurable in the pack, not to edit it in place.
