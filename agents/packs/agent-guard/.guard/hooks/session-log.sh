#!/usr/bin/env bash
# PostToolUse on everything: append one audit line per tool call.
# Logs are gitignored and local; read them after a session to see what it did.
set -uo pipefail
source "$(dirname "$0")/_lib.sh"
read_input; require_jq
SUMMARY="$(jq -c '{tool:(.tool_name // .tool), file:(.tool_input.file_path // .tool_input.path // null), cmd:(.tool_input.command // null)}' <<<"$INPUT" 2>/dev/null)"
printf '{"ts":"%s","event":"tool","data":%s}\n' "$(date -u +%FT%TZ)" "${SUMMARY:-null}" \
  >> "$LOG_DIR/session-$(date -u +%F).jsonl" 2>/dev/null || true
exit 0
