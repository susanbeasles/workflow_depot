"""Offline structural checks for the release workflow and its composite actions."""

import pathlib
import re

import yaml

root = pathlib.Path(__file__).resolve().parents[1]
workflows = root / ".github/workflows"
actions = root / ".github/actions"


def load(path):
    return yaml.load(path.read_text(), Loader=yaml.BaseLoader)


PINNED = re.compile(
    r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$"
)
# Third-party pins allowed in release code: the qualified registry entries plus the
# lead-reviewed attest-build-provenance v4.2.2 commit.
ALLOWED_PINS = {
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
    "sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6",
    "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
}
REQUIRED_ACTIONS = [
    "compute-release-version",
    "resolve-release-context",
    "read-application-manifest",
    "build-worker-bundle",
    "bundle-migrations",
    "write-authorization-policy",
    "generate-sbom",
    "checksum-bundles",
    "assemble-release",
    "write-release-manifest",
    "verify-release",
    "attest-release",
    "publish-github-release",
    "publish-release-objects",
    "submit-promotion-request",
]


def check_uses(value, where):
    if value.startswith("./"):
        return
    assert PINNED.match(value), (
        f"{where}: uses must be local or pinned to a 40-hex SHA: {value}"
    )
    assert value in ALLOWED_PINS, (
        f"{where}: third-party action not on the reviewed pin list: {value}"
    )


def local_action(step):
    uses = step.get("uses", "")
    prefix = "./.depot/.github/actions/"
    return uses[len(prefix) :] if uses.startswith(prefix) else None


# Every workflow in the repository: no pull_request_target, no inherited secrets.
for path in sorted(workflows.glob("*.y*ml")):
    text = path.read_text()
    assert "pull_request_target" not in text, (
        f"{path.name}: pull_request_target is forbidden"
    )
    assert not re.search(r"secrets:\s*inherit", text), (
        f"{path.name}: secrets: inherit is forbidden"
    )

# Composite actions: one concern each, bash with strict mode, no expressions in scripts.
for name in REQUIRED_ACTIONS:
    action = load(actions / name / "action.yml")
    assert action["runs"]["using"] == "composite", f"{name}: must be a composite action"
    for index, step in enumerate(action["runs"]["steps"]):
        where = f"actions/{name} step {index}"
        if "uses" in step:
            check_uses(step["uses"], where)
            continue
        assert step.get("shell") == "bash", f"{where}: shell must be bash"
        assert step["run"].startswith("set -euo pipefail\n"), (
            f"{where}: run must start with set -euo pipefail"
        )
        assert "${{" not in step["run"], (
            f"{where}: no expression interpolation inside run"
        )
    if "secrets." in (actions / name / "action.yml").read_text():
        raise AssertionError(
            f"{name}: composite actions receive credentials only as inputs"
        )

release = load(workflows / "release.yml")
assert set(release["on"]) == {"workflow_call"}, (
    "release.yml must only be a reusable workflow"
)
assert release["permissions"] == {}, (
    "release.yml must declare permissions: {} at the top level"
)
jobs = release["jobs"]
assert list(jobs) == ["bundle", "attest", "publish", "publish-objects"], (
    "unexpected release jobs"
)
assert "needs" not in jobs["bundle"]
assert jobs["attest"]["needs"] == "bundle"
assert jobs["publish"]["needs"] == ["bundle", "attest"]
assert jobs["publish-objects"]["needs"] == ["bundle", "publish"]
assert jobs["attest"]["if"] == "needs.bundle.outputs.released == 'true'"
assert (
    "inputs.r2_account_id != ''" in jobs["publish-objects"]["if"]
    and "inputs.r2_bucket != ''" in jobs["publish-objects"]["if"]
)
expected_permissions = {
    "bundle": {"contents": "read"},
    "attest": {"contents": "read", "id-token": "write", "attestations": "write"},
    "publish": {"contents": "write"},
    "publish-objects": {"contents": "read"},
}
for job_name, job in jobs.items():
    assert job["permissions"] == expected_permissions[job_name], (
        f"{job_name}: unexpected permissions {job['permissions']}"
    )
    assert int(job["timeout-minutes"]) > 0, f"{job_name}: timeout required"
    assert job["runs-on"] == "ubuntu-24.04", (
        f"{job_name}: GitHub-hosted ubuntu-24.04 required"
    )
    secrets_used = "secrets." in yaml.safe_dump(job)
    assert secrets_used == (job_name == "publish-objects"), (
        f"{job_name}: secrets are only for R2 publication"
    )
    for index, step in enumerate(job["steps"]):
        where = f"release.yml {job_name} step {index}"
        if "uses" in step:
            check_uses(step["uses"], where)
            if step["uses"].startswith("actions/checkout@"):
                assert step["with"]["persist-credentials"] == "false", (
                    f"{where}: persist-credentials must be false"
                )
        if "run" in step:
            assert step.get("shell") == "bash" and step["run"].startswith(
                "set -euo pipefail\n"
            ), f"{where}: strict bash required"
            assert "${{" not in step["run"], (
                f"{where}: no expression interpolation inside run"
            )
        assert local_action(step) != "submit-promotion-request", (
            "submit-promotion-request belongs to the deploy stage"
        )


def sequence(job_name):
    return [a for a in map(local_action, jobs[job_name]["steps"]) if a]


assert sequence("bundle") == [
    "compute-release-version",
    "resolve-release-context",
    "read-application-manifest",
    "build-worker-bundle",
    "bundle-migrations",
    "write-authorization-policy",
    "generate-sbom",
    "checksum-bundles",
    "assemble-release",
    "write-release-manifest",
    "verify-release",
], sequence("bundle")
assert sequence("attest") == ["verify-release", "attest-release"]
assert sequence("publish") == ["verify-release", "publish-github-release"]
assert sequence("publish-objects") == ["verify-release", "publish-release-objects"]
for job_name in ["publish", "publish-objects"]:
    verify = next(
        s for s in jobs[job_name]["steps"] if local_action(s) == "verify-release"
    )
    assert verify["with"]["stage"] == "signed", (
        f"{job_name}: verify signed bundles before publication"
    )
upload = jobs["bundle"]["steps"][-2]
assert (
    upload["uses"].startswith("actions/upload-artifact@")
    and upload["if"] == "steps.version.outputs.released == 'true'"
)
print(
    "Verified release.yml: bundle -> attest -> publish -> optional R2, least-privilege jobs, pinned uses, strict composite actions."
)
