#!/usr/bin/env bash
# Stop: the agent is not "done" until the project's own gate passes.
# Honors stop_hook_active so one failed retry can't loop forever.
set -uo pipefail
source "$(dirname "$0")/_lib.sh"
read_input; require_jq

if [[ "$(field '.stop_hook_active')" == "true" ]]; then
  # Already sent it back once this turn. Let it stop; the human sees the state.
  exit 0
fi

OUT="$("$GUARD_DIR/checks/on-stop" 2>&1)"; RC=$?
if [[ $RC -ne 0 ]]; then
  log_event stop-blocked "gate failed"
  {
    echo "AGENT-GUARD: the completion gate failed. You are not done. Fix the failures below, then stop again."
    echo "$OUT" | tail -n 80
  } >&2
  exit 2
fi
exit 0
