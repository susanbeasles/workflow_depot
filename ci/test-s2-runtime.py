#!/usr/bin/env python3
"""Regression checks for stage-2 failures seen on the first full caller run (porchlight run 38785256092)."""
import pathlib, re, subprocess, sys, tempfile
sys.dont_write_bytecode = True
root = pathlib.Path(__file__).resolve().parents[1]
sa = root / "security-assurance"
sys.path.insert(0, str(sa / ".github/scripts"))
import detect_ecosystems  # noqa: E402

# CodeQL accepts only build-mode none for Rust.
assert "rust" in detect_ecosystems.CODEQL_NO_BUILD

# ShellCheck must be invoked directly so exit 1 (findings) is not turned into xargs' 123.
sc = (sa / ".github/actions/sast-shellcheck/action.yml").read_text()
assert "xargs -0 -a \"$RUNNER_TEMP/sh.list\" timeout 600 shellcheck" not in sc
assert re.search(r'shellcheck -f json -S style -x -- "\$\{SH_FILES\[@\]\}"', sc)
with tempfile.TemporaryDirectory() as t:
    fake = pathlib.Path(t, "shellcheck"); fake.write_text("#!/bin/sh\necho '[]'; exit 1\n"); fake.chmod(0o755)
    lst = pathlib.Path(t, "sh.list"); lst.write_bytes(b"a.sh\0b c.sh\0")
    rc = subprocess.run(["bash", "-c", f'PATH={t}:$PATH; mapfile -d "" SH_FILES < {lst}; shellcheck -f json -S style -x -- "${{SH_FILES[@]}}" >/dev/null; echo $?'],
                        capture_output=True, text=True).stdout.strip()
    assert rc == "1", rc

# The live workflow must not use setup-python (its interpreter has no PyYAML).
live = (root / ".github/workflows/security-assurance.yml").read_text()
assert "actions/setup-python" not in live
assert '/usr/bin/python3 -m venv --system-site-packages "$RUNNER_TEMP/pyenv"' in live
print("s2 runtime regressions: ok")
