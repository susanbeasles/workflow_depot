#!/usr/bin/env bash
# Current state of affairs across all managed repos -> STATUS.md + state/status.json
source "$(dirname "$0")/lib.sh"
ver="$(pack_version agent-guard)"
rows=(); json=()
for repo in $(target_repos); do
  meta="$(gh api "repos/$OWNER/$repo" 2>/dev/null || echo '{}')"
  vis="$(jq -r '.visibility // "?"' <<<"$meta")"
  default="$(jq -r '.default_branch // "main"' <<<"$meta")"
  ss="$(jq -r '.security_and_analysis.secret_scanning.status // "n/a"' <<<"$meta")"
  pp="$(jq -r '.security_and_analysis.secret_scanning_push_protection.status // "n/a"' <<<"$meta")"
  # Branch protection: 200 = protected, 404 = none, 403 = plan doesn't allow it
  bp_code="$(gh api "repos/$OWNER/$repo/branches/$default/protection" -i 2>/dev/null | head -1 | grep -oE '[0-9]{3}' || echo "000")"
  case "$bp_code" in 200) bp="protected";; 404) bp="none";; 403) bp="plan-blocked";; *) bp="?";; esac
  rulesets="$(gh api "repos/$OWNER/$repo/rulesets" -q 'length' 2>/dev/null || echo 0)"
  dest="$WORK/$repo"; rm -rf "$dest"
  if gh repo clone "$OWNER/$repo" "$dest" -- --depth 1 --quiet 2>/dev/null; then
    inst="$(installed_version "$dest")"
    d="$(drift agent-guard "$dest" | wc -l | tr -d ' ')"
    if [[ "$inst" == "-" ]]; then state="missing"; elif [[ "$d" -gt 0 ]]; then state="drift($d)"; elif [[ "$inst" != "$ver" ]]; then state="stale"; else state="ok"; fi
    seeded_missing="$(while read -r k p; do [[ $k == seeded && ! -e "$dest/$p" ]] && echo "$p"; done < <(manifest agent-guard) | wc -l | tr -d ' ')"
  else inst="-"; state="clone-failed"; seeded_missing="?"; fi
  pr="$(gh pr list -R "$OWNER/$repo" --head chore/workflow-depo-sync --json number -q '.[0].number' 2>/dev/null || true)"
  rows+=("| $repo | $vis | $inst | $state | ${pr:+#$pr} | $bp / $rulesets rulesets | $ss / $pp |")
  json+=("$(jq -nc --arg r "$repo" --arg v "$vis" --arg i "$inst" --arg s "$state" --arg pr "$pr" --arg bp "$bp" --arg rs "$rulesets" --arg ss "$ss" --arg pp "$pp" \
    '{repo:$r,visibility:$v,installed:$i,state:$s,open_pr:$pr,branch_protection:$bp,rulesets:($rs|tonumber),secret_scanning:$ss,push_protection:$pp}')")
done
printf '%s\n' "${json[@]}" | jq -s '{generated:(now|todate),pack_version:"'"$ver"'",repos:.}' > "$STATE_DIR/status.json"
{
  echo "# Current state of affairs"; echo
  echo "Generated $(date -u +'%F %T UTC') · agent-guard pack version **$ver** · owner \`$OWNER\`"; echo
  echo "| Repo | Visibility | Installed | State | Sync PR | Branch protection | Secret scan / push protect |"
  echo "|---|---|---|---|---|---|---|"
  printf '%s\n' "${rows[@]}"
  echo; echo "State: **ok** = current, **stale** = older version, **drift(n)** = n managed files edited in-repo, **missing** = not installed."
  echo "Branch protection **plan-blocked** = private repo on a plan without protection (403)."
} > "$DEPO_ROOT/STATUS.md"
echo "wrote STATUS.md and state/status.json"; cat "$DEPO_ROOT/STATUS.md"
