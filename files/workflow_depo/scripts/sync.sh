#!/usr/bin/env bash
# Distribute packs to every managed repo via pull request.
#   scripts/sync.sh [--dry-run] [--repo NAME]...
# Env: OWNER (default: gh auth user), GH_TOKEN (fine-grained PAT; see README).
source "$(dirname "$0")/lib.sh"
DRY=0; ONLY=()
while [[ $# -gt 0 ]]; do case "$1" in
  --dry-run) DRY=1;; --repo) ONLY+=("$2"); shift;; *) echo "unknown arg $1" >&2; exit 1;; esac; shift; done

PACKS="$(jq -r '.packs[]' <<<"$CONFIG")"
repos="$(target_repos)"; [[ ${#ONLY[@]} -gt 0 ]] && repos="$(printf '%s\n' "${ONLY[@]}")"
summary="$STATE_DIR/sync-$(date -u +%F).jsonl"; : > "$summary"

for repo in $repos; do
  dest="$WORK/$repo"; rm -rf "$dest"
  if ! gh repo clone "$OWNER/$repo" "$dest" -- --depth 1 --quiet 2>/dev/null; then
    echo "SKIP  $repo (clone failed)"; jq -nc --arg r "$repo" '{repo:$r,result:"clone-failed"}' >> "$summary"; continue
  fi
  default="$(git -C "$dest" rev-parse --abbrev-ref HEAD)"
  changes=""
  for pack in $PACKS; do
    c="$(apply_pack "$pack" "$dest")"; [[ -n "$c" ]] && changes+="$pack:"$'\n'"$c"$'\n'
  done
  if [[ -z "$(git -C "$dest" status --porcelain)" ]]; then
    echo "OK    $repo (up to date)"; jq -nc --arg r "$repo" '{repo:$r,result:"up-to-date"}' >> "$summary"; continue
  fi
  ver="$(pack_version agent-guard)"; branch="chore/workflow-depo-sync"
  echo "SYNC  $repo"; echo "$changes" | sed 's/^/        /'
  if [[ $DRY -eq 1 ]]; then jq -nc --arg r "$repo" '{repo:$r,result:"would-change"}' >> "$summary"; continue; fi
  git -C "$dest" checkout -q -B "$branch"
  git -C "$dest" add -A
  git -C "$dest" -c user.name="workflow_depo" -c user.email="workflow_depo@users.noreply.github.com" \
      commit -q -m "chore: sync workflow_depo packs (agent-guard $ver)" -m "$changes"
  git -C "$dest" push -q -f origin "$branch"
  if pr="$(gh pr list -R "$OWNER/$repo" --head "$branch" --json number -q '.[0].number')" && [[ -n "$pr" ]]; then
    echo "        updated PR #$pr"
  else
    pr="$(gh pr create -R "$OWNER/$repo" --base "$default" --head "$branch" \
      --title "chore: sync workflow_depo packs (agent-guard $ver)" \
      --body "Automated by workflow_depo. Managed files are overwritten; seeded files are only created if missing.

$changes

Merge via **squash** in the UI so GitHub signs the merge commit (satisfies required signed commits)." \
      | grep -oE '[0-9]+$')"
    echo "        opened PR #$pr"
  fi
  jq -nc --arg r "$repo" --arg pr "$pr" '{repo:$r,result:"pr",pr:$pr}' >> "$summary"
done
echo; echo "summary: $summary"
