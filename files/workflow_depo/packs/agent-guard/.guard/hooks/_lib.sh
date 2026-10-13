#!/usr/bin/env bash
# Shared helpers for agent-guard hooks. Sourced, not executed.
# Works for Claude Code and Codex CLI: both pass a JSON payload on stdin.

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
GUARD_DIR="$ROOT/.guard"
LOG_DIR="$GUARD_DIR/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || true

# Paths the agent may read but never modify. The human edits these.
PROTECTED_RE='(^|/)(\.claude|\.codex|\.github|\.guard|\.git)(/|$)|(^|/)(AGENTS\.md|CLAUDE\.md|\.pre-commit-config\.yaml)$'
# Same set, but matched inside a shell command where a path can follow a space, quote or '='.
PROTECTED_IN_CMD_RE='(^|[[:space:]"'"'"'=/])(\.claude|\.codex|\.github|\.guard|\.git)(/|[[:space:]]|$)|(^|[[:space:]"'"'"'=/])(AGENTS\.md|CLAUDE\.md|\.pre-commit-config\.yaml)([[:space:]"'"'"']|$)'

# Files that hold credentials. Reading or writing them is blocked.
SECRET_FILE_RE='(^|/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(\.json)?|id_(rsa|ed25519|ecdsa)(\.pub)?)$|\.(pem|key|p12|pfx|jks|kdbx)$|(^|/)\.ssh/|(^|/)\.aws/|(^|/)\.config/(gh|op)/'

have() { command -v "$1" >/dev/null 2>&1; }

read_input() { INPUT="$(cat)"; }

# jq is required for parsing. If absent, fail open with a loud warning
# rather than blocking every tool call on a misconfigured machine.
require_jq() {
  if ! have jq; then
    echo "agent-guard: jq not installed; hook cannot inspect input (allowing)" >&2
    exit 0
  fi
}

field() { jq -r "$1 // \"\"" <<<"$INPUT"; }

tool_name()  { field '.tool_name // .tool'; }
file_path()  { field '.tool_input.file_path // .tool_input.path // .tool_input.notebook_path'; }
command_str() {
  jq -r '(.tool_input.command // .tool_input.cmd // "") | if type=="array" then join(" ") else . end' <<<"$INPUT"
}

rel() { # make a path relative to the project root for matching
  local p="$1"
  p="${p#"$ROOT"/}"
  p="${p#./}"
  printf '%s' "$p"
}

deny() {
  echo "AGENT-GUARD BLOCKED: $1" >&2
  echo "If this was legitimate, the human must do it manually or add an exception in .guard/." >&2
  exit 2
}

log_event() { # kind, message
  printf '{"ts":"%s","kind":"%s","tool":"%s","msg":%s}\n' \
    "$(date -u +%FT%TZ)" "$1" "$(tool_name)" "$(jq -Rs . <<<"$2")" \
    >> "$LOG_DIR/guard-$(date -u +%F).jsonl" 2>/dev/null || true
}
