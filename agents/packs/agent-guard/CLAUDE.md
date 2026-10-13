Follow AGENTS.md in this repository. It is the canonical rule set; nothing here overrides it.

Claude Code specifics:
- Hooks in .claude/settings.json enforce the trust boundary and run checks after every edit.
- If a hook blocks you, the reason is in the output. Do not retry with a variation.
- Use the Read tool for files, not `cat`. Use Edit for changes, not `sed -i`.
