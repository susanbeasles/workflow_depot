#!/usr/bin/env python3
"""Print the number of findings at the given severities, or ERR if the findings file is missing/malformed/has a parse_error.

Accepted findings: when ACCEPTED_REPO (the scanned git checkout) and ACCEPTED_REF (the
repository's default branch, e.g. refs/remotes/origin/main) are set, entries in
.security/accepted-findings.yml AS COMMITTED ON THAT REF are applied. The commit under test
cannot add its own exceptions. An entry matches one finding only on rule + path + the SHA-256
of that file's bytes in the scanned checkout, so any edit to the file re-blocks. Entries
need a reason and an unexpired date (at most 366 days ahead). Matches move from "items" to
"accepted" (with the reason) in the findings file, so result.py and the gate never count them
and the evidence still shows them. A malformed list fails closed (ERR).
"""
import datetime, hashlib, json, os, subprocess, sys

ACCEPTED_FILE = ".security/accepted-findings.yml"


def load_accepted(repo, ref):
    """Entries from the default branch; [] when the ref or file does not exist."""
    r = subprocess.run(["git", "-C", repo, "show", f"{ref}:{ACCEPTED_FILE}"], capture_output=True)
    if r.returncode != 0:
        return []
    import yaml
    doc = yaml.safe_load(r.stdout.decode("utf-8"))
    if not isinstance(doc, dict) or doc.get("version") != 1 or not isinstance(doc.get("accepted"), list):
        raise ValueError("accepted-findings: need version: 1 and an accepted list")
    today = datetime.date.today()
    out = []
    for e in doc["accepted"]:
        if not isinstance(e, dict) or set(e) != {"rule", "path", "sha256", "reason", "expires"}:
            raise ValueError(f"accepted-findings: entry needs exactly rule, path, sha256, reason, expires: {e!r}")
        exp = e["expires"] if isinstance(e["expires"], datetime.date) else datetime.date.fromisoformat(str(e["expires"]))
        if not str(e["reason"]).strip() or len(str(e["sha256"])) != 64 or exp > today + datetime.timedelta(days=366):
            raise ValueError(f"accepted-findings: bad reason, sha256 or expiry (max 366 days): {e!r}")
        if exp >= today:
            out.append(e)
    return out


def rel_path(path, repo):
    """Scanner paths are absolute, workspace-relative (src/README.md) or root-relative (README.md)."""
    root, p = os.path.abspath(repo), str(path)
    ap = os.path.abspath(p)
    if ap.startswith(root + os.sep):
        return os.path.relpath(ap, root)
    return os.path.normpath(p)


def file_sha256(repo, rel):
    full = os.path.join(repo, rel)
    if os.path.islink(full) or not os.path.isfile(full) or os.path.realpath(full) != os.path.join(os.path.realpath(repo), rel):
        return None
    with open(full, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def apply_accepted(findings_path, d):
    repo, ref = os.environ.get("ACCEPTED_REPO", ""), os.environ.get("ACCEPTED_REF", "")
    if not repo or not ref.startswith("refs/remotes/origin/") or ref == "refs/remotes/origin/":
        return
    entries = load_accepted(repo, ref)
    if not entries:
        return
    keep, accepted = [], list(d.get("accepted", []))
    for item in d["items"]:
        rel = rel_path(item.get("path", ""), repo)
        digest = file_sha256(repo, rel)
        hit = next((e for e in entries if e["rule"] == item.get("rule") and e["path"] == rel and digest == e["sha256"]), None)
        if hit:
            accepted.append({**item, "accepted_reason": hit["reason"], "accepted_until": str(hit["expires"])})
        else:
            keep.append(item)
    if len(keep) != len(d["items"]):
        d["items"], d["accepted"] = keep, accepted
        with open(findings_path, "w") as f:
            json.dump(d, f, indent=2)


try:
    d = json.load(open(sys.argv[1]))
    if d.get("parse_error"):
        print("ERR"); sys.exit(0)
    apply_accepted(sys.argv[1], d)
    sevs = set((sys.argv[2] if len(sys.argv) > 2 else "critical,high").split(","))
    print(sum(1 for i in d["items"] if str(i.get("severity", "")).lower() in sevs))
except Exception:
    print("ERR")
