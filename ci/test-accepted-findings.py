"""Accepted findings: default-branch only, exact rule+path+file digest, reason and expiry, fail closed."""
import datetime, hashlib, json, os, pathlib, subprocess, sys, tempfile

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "security-assurance/.github/scripts/count_blocking.py"


def git(repo, *args):
    subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)


def run(work, repo, items, env_extra=None):
    f = os.path.join(work, "findings.json")
    json.dump({"items": items}, open(f, "w"))
    env = {**os.environ, "ACCEPTED_REPO": repo, "ACCEPTED_REF": "refs/remotes/origin/main", **(env_extra or {})}
    out = subprocess.run([sys.executable, str(SCRIPT), f], capture_output=True, text=True, cwd=work, env=env).stdout.strip()
    return out, json.load(open(f))


with tempfile.TemporaryDirectory() as work:
    repo = os.path.join(work, "src")
    os.makedirs(repo)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t")
    pathlib.Path(repo, "README.md").write_text("detects curl | sh\n")
    digest = hashlib.sha256(b"detects curl | sh\n").hexdigest()
    later = (datetime.date.today() + datetime.timedelta(days=90)).isoformat()

    def accept(entries):
        os.makedirs(os.path.join(repo, ".security"), exist_ok=True)
        pathlib.Path(repo, ".security/accepted-findings.yml").write_text(json.dumps({"version": 1, "accepted": entries}))
        git(repo, "add", "-A"); git(repo, "commit", "-qm", "x")
        git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")

    hit = {"severity": "high", "rule": "SUSP_Shell_Curl_Pipe_Sh", "path": "src/README.md", "message": "m"}
    entry = {"rule": "SUSP_Shell_Curl_Pipe_Sh", "path": "README.md", "sha256": digest, "reason": "documents the detected attack", "expires": later}

    # No list on the default branch: nothing accepted.
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "init"); git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    assert run(work, repo, [hit])[0] == "1"

    accept([entry])
    n, d = run(work, repo, [hit, {**hit, "path": "src/OTHER.md"}])
    assert n == "1" and len(d["accepted"]) == 1 and d["accepted"][0]["accepted_reason"], (n, d)

    # Editing the file changes its digest: blocks again.
    pathlib.Path(repo, "README.md").write_text("detects curl | sh\nmore\n")
    assert run(work, repo, [hit])[0] == "1"
    pathlib.Path(repo, "README.md").write_text("detects curl | sh\n")

    # Different rule on the same file: not accepted.
    assert run(work, repo, [{**hit, "rule": "AI-FETCH-AND-EXECUTE"}])[0] == "1"

    # An entry only in the commit under test (not on the default branch) is ignored.
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD~1")
    assert run(work, repo, [hit])[0] == "1"
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")

    # Expired entries are ignored; expiry beyond 366 days, missing reason or extra keys fail closed.
    past = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    accept([{**entry, "expires": past}]); assert run(work, repo, [hit])[0] == "1"
    far = (datetime.date.today() + datetime.timedelta(days=400)).isoformat()
    accept([{**entry, "expires": far}]); assert run(work, repo, [hit])[0] == "ERR"
    accept([{**entry, "reason": " "}]); assert run(work, repo, [hit])[0] == "ERR"
    accept([{**entry, "severity": "low"}]); assert run(work, repo, [hit])[0] == "ERR"

    # Without the env (non-admission jobs) nothing is accepted.
    accept([entry])
    assert run(work, repo, [hit], {"ACCEPTED_REF": ""})[0] == "1"
print("OK")
