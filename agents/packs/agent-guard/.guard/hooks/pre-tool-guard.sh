#!/usr/bin/env bash
# PreToolUse: the hard gate. Blocks the tool call (exit 2) with a reason the
# agent sees, for anything that modifies the control plane, touches secrets,
# is destructive, or talks to a host that isn't allowlisted.
set -uo pipefail
source "$(dirname "$0")/_lib.sh"
read_input; require_jq

TOOL="$(tool_name)"
FILE="$(rel "$(file_path)")"
CMD="$(command_str)"

# ---- File-based tools (Read/Write/Edit/MultiEdit/NotebookEdit) -------------
if [[ -n "$FILE" ]]; then
  if [[ "$FILE" =~ $SECRET_FILE_RE ]]; then
    log_event block "secret file access: $FILE"
    deny "'$FILE' looks like a credential file. The agent never reads or writes these."
  fi
  case "$TOOL" in
    Write|Edit|MultiEdit|NotebookEdit|write|edit|apply_patch)
      if [[ "$FILE" =~ $PROTECTED_RE ]]; then
        log_event block "protected path edit: $FILE"
        deny "'$FILE' is part of the agent control plane (instructions, hooks, CI). Propose the change in chat; the human applies it."
      fi ;;
  esac
fi

# ---- Shell commands --------------------------------------------------------
[[ -z "$CMD" ]] && exit 0

# 1. Control-plane mutation via shell
MUTATE_RE='(^|[^a-z])(rm|mv|cp|tee|truncate|chmod|chown|sed[[:space:]]+-[a-zA-Z]*i|git[[:space:]]+(checkout|restore)|install)([^a-z]|$)|>>?[[:space:]]*[^&]'
if [[ "$CMD" =~ $PROTECTED_IN_CMD_RE ]] && [[ "$CMD" =~ $MUTATE_RE ]]; then
  log_event block "protected path via shell: $CMD"
  deny "That command modifies a control-plane file (.claude/, .codex/, .github/, .guard/, AGENTS.md, CLAUDE.md). Propose it in chat instead."
fi

# 2. Destructive patterns
DESTRUCTIVE_RE='rm[[:space:]]+-[a-zA-Z]*r[a-zA-Z]*[[:space:]]+(/|~|\*|\.|\$HOME)([[:space:]]|$)|git[[:space:]]+push.*(--force|-f([[:space:]]|$)|\+[a-zA-Z])|git[[:space:]]+reset[[:space:]]+--hard|git[[:space:]]+clean[[:space:]]+-[a-zA-Z]*[fx]|git[[:space:]]+branch[[:space:]]+-D[[:space:]]+(main|master)|chmod[[:space:]]+-R[[:space:]]+777|mkfs\.|dd[[:space:]]+if=|:\(\)\{[[:space:]]*:\|:&[[:space:]]*\};:|(^|[^a-z])(shutdown|reboot|killall)([^a-z]|$)|pkill[[:space:]]+-9[[:space:]]+-f|terraform[[:space:]]+(destroy|apply[[:space:]]+-auto-approve)|wrangler[[:space:]]+delete'
if [[ "$CMD" =~ $DESTRUCTIVE_RE ]]; then
  log_event block "destructive: $CMD"
  deny "Destructive command. Explain what you want to achieve and let the human run it."
fi

# 3. Pipe-to-shell and remote code execution
PIPE_SH_RE='(curl|wget|fetch)[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z|da|k|)sh([[:space:]]|$)'
PROC_SUB_RE='(bash|sh|python[23]?|node)[[:space:]]+<\(.*(curl|wget)'
URL_INSTALL_RE='(npm|pnpm|yarn|pip3?|pipx|cargo|go)[[:space:]]+(i|install|add|get)[^|;&]*(git\+|https?://|github\.com|ssh://)'
if [[ "$CMD" =~ $PIPE_SH_RE ]] || [[ "$CMD" =~ $PROC_SUB_RE ]] || [[ "$CMD" =~ $URL_INSTALL_RE ]]; then
  log_event block "remote exec/install: $CMD"
  deny "Executing or installing code straight from a URL is not allowed. Pin a published package version or ask the human."
fi

# 4. Secret exfiltration via shell
READ_SECRET_RE="(^|[^a-z])(cat|less|more|head|tail|bat|strings|base64|xxd|hexdump|cp|scp|curl.*-F|curl.*--data)[^|;&]*($SECRET_FILE_RE)"
ENV_DUMP_RE='(^|[^a-z|])(printenv|env|export[[:space:]]*-p|set)[[:space:]]*($|\||;|>)'
ECHO_SECRET_RE='echo[[:space:]]+["'"'"']?\$\{?[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD|PASS|CREDENTIAL|AUTH)[A-Z_]*'
VAULT_PIPE_RE='(op|vault|aws|gh|wrangler)[[:space:]]+(read|secret|secrets|auth|kv)[^|;&]*(\|[[:space:]]*(curl|nc|ncat|socat)|>[[:space:]]*/tmp)'
if [[ "$CMD" =~ $READ_SECRET_RE ]] || [[ "$CMD" =~ $ENV_DUMP_RE ]] || [[ "$CMD" =~ $ECHO_SECRET_RE ]] || [[ "$CMD" =~ $VAULT_PIPE_RE ]]; then
  log_event block "secret exfil: $CMD"
  deny "That reads or dumps credentials. The agent never handles secret values; use bindings or ask the human."
fi

# 5. Network egress allowlist (http(s), ssh/scp, raw sockets)
ALLOW="$GUARD_DIR/allowed-hosts"
if [[ "$CMD" =~ (^|[^a-z])(nc|ncat|socat|telnet)([^a-z]|$) ]]; then
  log_event block "raw socket: $CMD"
  deny "Raw socket tools are not allowed."
fi
HOSTS="$(grep -oE 'https?://[A-Za-z0-9._-]+(:[0-9]+)?|(ssh|scp)[[:space:]]+[^[:space:]]+|git@[A-Za-z0-9._-]+' <<<"$CMD" \
        | sed -E 's#^https?://##; s#^(ssh|scp)[[:space:]]+##; s#^git@##; s#^[^@]*@##; s#:.*$##; s#/.*$##' | sort -u)"
if [[ -n "$HOSTS" ]]; then
  [[ -r "$ALLOW" ]] || deny "Command contacts a network host but .guard/allowed-hosts is missing."
  for h in $HOSTS; do
    [[ "$h" =~ ^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$ ]] && continue
    ok=0
    while IFS= read -r pat; do
      pat="${pat%%#*}"; pat="${pat//[[:space:]]/}"; [[ -z "$pat" ]] && continue
      if [[ "$h" == "$pat" || "$h" == *".$pat" ]]; then ok=1; break; fi
    done < "$ALLOW"
    if [[ $ok -eq 0 ]]; then
      log_event block "egress to $h: $CMD"
      deny "Host '$h' is not in .guard/allowed-hosts. The human can add it if it's legitimate."
    fi
  done
fi

log_event allow "$CMD"
exit 0
