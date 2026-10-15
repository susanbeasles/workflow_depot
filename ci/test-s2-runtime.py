#!/usr/bin/env python3
"""Regression checks for stage-2 failures seen on the first full caller run (porchlight run 38785256092)."""
import json, pathlib, re, subprocess, sys, tempfile
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

# A waived CodeQL language reports NOT_APPLICABLE by name; the others still run; Semgrep covers Swift.
assert "codeql_waive_languages:" in live
assert "--status NOT_APPLICABLE --reason \"waived by caller (codeql_waive_languages)" in live
assert "if: ${{ !contains(format(' {0} ', inputs.codeql_waive_languages), format(' {0} ', matrix.language)) }}\n        uses: ./.security-depot/.github/actions/sast-codeql" in live
assert " p/swift " in (sa / ".github/actions/sast-semgrep/action.yml").read_text()
print("codeql waiver: ok")

# Exit 1 means "findings"; the policy fail_on severities decide, after accepted findings.
import yaml
pol = {c["id"]: c for c in yaml.safe_load((sa / "policy/release-policy.yml").read_text())["controls"]}
for rel, ctrl in [("sast-semgrep", "SAST-SEMGREP"), ("sast-ecosystem", "SAST-BANDIT"), ("sast-shellcheck", "SAST-SHELLCHECK")]:
    t = (sa / f".github/actions/{rel}/action.yml").read_text()
    sev = ",".join(pol[ctrl]["fail_on"])
    assert f'0|1) ST=$(st "$(python3 "$S/count_blocking.py" "$NF" {sev})");; *) ST=TOOL_FAILURE' in t, (rel, sev)
with tempfile.TemporaryDirectory() as t:
    f = pathlib.Path(t, "f.json")
    f.write_text(json.dumps({"items": [{"severity": "medium", "rule": "B108", "path": "x.py"}, {"severity": "low", "rule": "r", "path": "y"}]}))
    out = subprocess.run([sys.executable, str(sa / ".github/scripts/count_blocking.py"), str(f), "high"], capture_output=True, text=True, env={"PATH": "/usr/bin"}).stdout.strip()
    assert out == "0", out
print("fail_on status: ok")
assert 'echo "PIP_NO_CACHE_DIR=1" >> "$GITHUB_ENV"' in live
print("pip cache isolation: ok")
