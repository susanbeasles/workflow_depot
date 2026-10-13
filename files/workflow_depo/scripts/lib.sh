#!/usr/bin/env bash
# Shared helpers for workflow_depo scripts. Requires: gh (authenticated), jq, git, python3 (yaml).
set -euo pipefail
DEPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWNER="${OWNER:-$(gh api user -q .login)}"
WORK="${WORK:-$(mktemp -d -t depo.XXXXXX)}"
STATE_DIR="$DEPO_ROOT/state"; mkdir -p "$STATE_DIR"

yq_() { python3 -c 'import sys,yaml,json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))' "$1"; }
CONFIG="$(yq_ "$DEPO_ROOT/repos.yml")"

# All target repo names, honoring include/exclude.
target_repos() {
  local include exclude all
  include="$(jq -r '.include // [] | .[]' <<<"$CONFIG")"
  exclude="$(jq -r '.exclude // [] | .[]' <<<"$CONFIG")"
  if [[ -n "$include" ]]; then all="$include"
  else all="$(gh repo list "$OWNER" --limit 500 --no-archived --source --json name -q '.[].name')"; fi
  grep -vxF -f <(printf '%s\n' $exclude) <<<"$all" | sort -u
}

pack_dir() { echo "$DEPO_ROOT/packs/$1"; }
pack_version() { cat "$(pack_dir "$1")/VERSION"; }
manifest() { grep -E '^(managed|seeded) ' "$(pack_dir "$1")/MANIFEST"; }

# Pack files may contain __OWNER__; rendered on the way out.
render() { sed "s/__OWNER__/$OWNER/g" "$1"; }

sha() { sha256sum "$1" 2>/dev/null | cut -c1-12 || echo "-"; }

# Apply a pack to a checkout. Prints "changed" lines. Does not commit.
apply_pack() { # pack, dest
  local pack="$1" dest="$2" src; src="$(pack_dir "$pack")"
  local changed=()
  while read -r kind path; do
    local from="$src/$path" to="$dest/$path"
    [[ -f "$from" ]] || { echo "::warning::$pack manifest lists missing file $path" >&2; continue; }
    if [[ "$kind" == managed ]]; then
      if ! cmp -s <(render "$from") "$to"; then mkdir -p "$(dirname "$to")"; render "$from" > "$to"; changed+=("$kind $path"); fi
    else
      if [[ ! -e "$to" ]]; then mkdir -p "$(dirname "$to")"; cp "$from" "$to"; changed+=("$kind $path"); fi
    fi
  done < <(manifest "$pack")
  chmod +x "$dest"/.guard/hooks/*.sh "$dest"/.guard/checks/* 2>/dev/null || true
  grep -qx '.guard/logs/' "$dest/.gitignore" 2>/dev/null || { echo '.guard/logs/' >> "$dest/.gitignore"; changed+=("managed .gitignore"); }
  printf '%s\n' "${changed[@]:-}"
}

# Drift report for a checkout: which managed files differ from the pack.
drift() { # pack, dest  -> prints paths that differ
  local pack="$1" dest="$2" src; src="$(pack_dir "$pack")"
  while read -r kind path; do
    [[ "$kind" == managed ]] || continue
    local from="$src/$path" to="$dest/$path"
    cmp -s <(render "$from") "$to" || echo "$path"
  done < <(manifest "$pack")
}

installed_version() { cat "$1/.guard/VERSION" 2>/dev/null || echo "-"; }
