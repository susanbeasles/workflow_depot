#!/usr/bin/env bash
# PostToolUse on Write/Edit: run fast checks on the file just touched and
# feed failures straight back to the agent (exit 2) so it fixes them now,
# not three edits later.
set -uo pipefail
source "$(dirname "$0")/_lib.sh"
read_input; require_jq

FILE="$(file_path)"
[[ -z "$FILE" || ! -f "$FILE" ]] && exit 0

OUT="$("$GUARD_DIR/checks/on-edit" "$FILE" 2>&1)"; RC=$?
if [[ $RC -ne 0 ]]; then
  log_event check-fail "$FILE"
  {
    echo "AGENT-GUARD: checks failed for $(rel "$FILE"). Fix these before doing anything else:"
    echo "$OUT" | tail -n 60
  } >&2
  exit 2
fi
exit 0
