#!/usr/bin/env python3
"""Print the number of findings at the given severities, or ERR if the findings file is missing/malformed/has a parse_error.

Acceptance rationale is read from an exact default-branch entry when optional
ACCEPTED_REPO/ACCEPTED_REF metadata is installed. Matches are recorded separately in
acceptance_annotations. Original items and their severities never move or change;
confirmed High/Critical findings retain their blocking count. Legacy suppressed
accepted items fail closed and require re-normalization from original evidence.
"""
import datetime, hashlib, json, os, re, subprocess, sys

ACCEPTED_FILE = ".security/accepted-findings.yml"


def load_accepted(repo, ref):
    """Entries from the default branch; [] when the ref or file does not exist."""
    r = subprocess.run(["git", "-C", repo, "show", f"{ref}:{ACCEPTED_FILE}"], capture_output=True)
    if r.returncode != 0:
        # PR checkouts are shallow and lack origin/<default>; fetch just that ref. If it still cannot be
        # read, nothing is accepted and every finding keeps blocking (fail closed).
        branch = ref.removeprefix("refs/remotes/origin/")
        subprocess.run(["git", "-C", repo, "fetch", "--quiet", "--no-tags", "--depth=1", "origin",
                        f"+refs/heads/{branch}:{ref}"], capture_output=True, timeout=120)
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
        if not isinstance(e["reason"], str) or not e["reason"].strip() or not isinstance(e["sha256"], str) \
                or not re.fullmatch(r"[0-9a-f]{64}", e["sha256"]) or not isinstance(e["rule"], str) \
                or not isinstance(e["path"], str) or exp > today + datetime.timedelta(days=366):
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
    """Compatibility name: attach rationale only; never accept away a finding."""
    if d.get("accepted"):
        raise ValueError("legacy suppressed findings require original-evidence re-normalization")
    repo, ref = os.environ.get("ACCEPTED_REPO", ""), os.environ.get("ACCEPTED_REF", "")
    annotations = []
    if repo and ref.startswith("refs/remotes/origin/") and ref != "refs/remotes/origin/":
        entries = load_accepted(repo, ref)
        for index, item in enumerate(d["items"]):
            rel = rel_path(item.get("path", ""), repo)
            digest = file_sha256(repo, rel)
            hit = next((e for e in entries if e["rule"] == item.get("rule") and e["path"] == rel and digest == e["sha256"]), None)
            if hit:
                annotations.append({"kind": "rationale-only", "item_index": index,
                                    "rule": item.get("rule"), "path": rel, "sha256": digest,
                                    "reason": hit["reason"], "expires": str(hit["expires"])})
    if annotations or "acceptance_annotations" in d:
        d["acceptance_annotations"] = annotations
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
