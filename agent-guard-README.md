# agent-guard

A drop-in control plane for coding agents (Claude Code, Codex CLI) that lives in the repo,
so it applies wherever the agent clones it: local, remote VM, or the vendors' cloud sandboxes.

It does three things:

1. **Hard blocks** (PreToolUse hook + Claude Code permission denies): control-plane edits,
   credential reads, env dumps, destructive git/shell, pipe-to-shell, URL installs, raw sockets,
   and any network host not in `.guard/allowed-hosts`.
2. **Immediate feedback** (PostToolUse hook): every edit is linted/type-checked/secret-scanned
   right away and failures are pushed back into the agent's context so it fixes them now.
3. **A completion gate** (Stop hook + CI): the agent can't end its turn until
   `.guard/checks/on-stop` passes, and CI runs the same gate plus full-history gitleaks on every PR.

Plus `AGENTS.md` / `CLAUDE.md` with a concrete trust boundary, and a per-tool-call audit log
in `.guard/logs/` (gitignored) so you can see what it did without watching it.

## Layout

```
AGENTS.md                      canonical rules (trust boundary + quality + comms)
CLAUDE.md                      "follow AGENTS.md" + Claude-specific notes
.claude/settings.json          Claude Code hooks + permission denies
.codex/hooks.json              Codex CLI hooks (same scripts)
.codex/config.toml             enables hooks for Codex (off by default upstream)
.guard/hooks/                  the hook scripts; shared, agent-agnostic
.guard/checks/on-edit          fast per-file checks   <- edit for your stack
.guard/checks/on-stop          the "done" definition  <- edit for your stack
.guard/allowed-hosts           egress allowlist       <- edit for your stack
.github/workflows/agent-guard.yml   CI gate: gitleaks + on-stop
.pre-commit-config.yaml        local push-protection substitute (gitleaks, no-commit-to-main)
install.sh                     copies all of this into a repo
```

## Install

```
./install.sh /path/to/your/repo
```

Then do the manual bits it prints: edit `allowed-hosts`, tune the two check scripts, make sure
`jq` (required), `gitleaks`, `shellcheck` and your linters exist on the machine or sandbox, run
`pre-commit install`, and for Codex run `/hooks` once in the TUI to activate. Commit everything.

## How the blocking works

Hooks receive a JSON payload on stdin (`tool_name`, `tool_input`) and exit `2` with a reason on
stderr to block. Both Claude Code and Codex surface that reason to the model, so a block is also
a correction. Allowed calls are logged; blocked calls are logged with the reason.

The agent can read control-plane files (so it knows the rules) but cannot write them, via Edit
tools or via the shell (`sed -i`, `>`, `tee`, `cp`, `mv`, `git checkout --` ...). Changing the
rules is a human action by design.

## Honest limits

- **Regex, not a parser.** A determined, obfuscated command can get past the shell patterns
  (`b""ash`, base64-wrapped payloads, aliases). This stops accidents and ordinary prompt
  injection, not an adversary with shell. The real backstop is the sandbox's egress allowlist
  and keeping secrets out of the agent's environment entirely.
- **Fails open without `jq`.** It warns loudly and allows, rather than bricking every tool call.
  Put `jq` in your sandbox image.
- **Codex needs activation.** Hooks are off upstream; `.codex/config.toml` turns them on, and
  since 0.129 you also confirm them once via `/hooks`. Whether Codex *cloud* tasks run repo
  hooks at all should be verified; if not, CI is the only hard gate there.
- **Claude Code web/remote**: hooks run inside that sandbox and can only reach what it can
  reach. A private Sonar/Semgrep instance means an Access service-token call, not localhost.
- **Stop gate retries once.** `stop_hook_active` is honored so a failing suite can't loop the
  agent forever; after one bounce it stops and you see the failing state.
- **`permissions.deny` is Claude Code only.** The hook duplicates every rule there, so Codex
  gets the same protection via the hook alone.

## Tuning

- Too noisy: tighten `on-edit` to only the tools you actually run; keep it under ~10s.
- Too loose: add patterns to `DESTRUCTIVE_RE` / `SECRET_FILE_RE` in `.guard/hooks/_lib.sh` and
  `pre-tool-guard.sh`. Every pattern has a test case in the shipped test battery idea below.
- New registry/API: add the host to `.guard/allowed-hosts` yourself. The agent can't.

Quick self-test after changes:

```
printf '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' | .guard/hooks/pre-tool-guard.sh; echo rc=$?   # expect 2
printf '{"tool_name":"Bash","tool_input":{"command":"npm test"}}' | .guard/hooks/pre-tool-guard.sh; echo rc=$?   # expect 0
```
