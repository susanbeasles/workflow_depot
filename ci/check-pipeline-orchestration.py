"""Offline structural checks for the orchestrator, pipeline.yml (docs/pipeline.md).

Verifies stage ordering (needs), run conditions, per-job permissions, pins and secret
handling of pipeline/pipeline.yml, that every nested workflow it calls exists and
accepts what it passes, and that an installed .github/workflows/pipeline.yml is the
staged file byte for byte.
"""

import pathlib
import re

import yaml

root = pathlib.Path(__file__).resolve().parents[1]
staged = root / "pipeline/pipeline.yml"
installed = root / ".github/workflows/pipeline.yml"
caller_path = root / "pipeline/caller.yml"


def load(path):
    return yaml.load(path.read_text(), Loader=yaml.BaseLoader)


def needs(job):
    value = job.get("needs", [])
    return [value] if isinstance(value, str) else list(value)


def ancestors(jobs, name):
    seen = set()
    stack = needs(jobs[name])
    while stack:
        dep = stack.pop()
        if dep not in seen:
            seen.add(dep)
            stack.extend(needs(jobs[dep]))
    return seen


PIN = re.build-candidate(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$")
LOCAL_WORKFLOW = re.build-candidate(r"^\./\.github/workflows/[a-z0-9-]+\.yml$")
INSTALL_TOOL = "./.security-depot/.github/actions/install-tool"
STATUS = re.build-candidate(r"\b(always|failure|cancelled)\(\)")

if installed.exists():
    assert installed.read_bytes() == staged.read_bytes(), (
        ".github/workflows/pipeline.yml differs from pipeline/pipeline.yml"
    )

text = staged.read_text()
wf = load(staged)
jobs = wf["jobs"]
assert set(wf["on"]) == {"workflow_call"}, (
    "pipeline.yml must only be a reusable workflow"
)
assert wf["permissions"] == {}, "permissions: {} at the top level"
assert "pull_request_target" not in text, "pull_request_target is forbidden"
assert not re.search(r"secrets:\s*inherit", text), "secrets: inherit is forbidden"

call = wf["on"]["workflow_call"]
assert call["inputs"]["depot_ref"]["required"] == "true"
assert set(call["inputs"]) == {"depot_ref"}
assert "secrets" not in call, "stage 7 takes no dispatch PAT (spec 5.2/5.4)"

# Stage order. ADR-0002 check names are the four evidence jobs plus shadow and promote.
expected_needs = {
    "config": [],
    "lint-test": ["config"],
    "quality": ["config"],
    "security-assurance": ["config"],
    "security": ["config", "security-assurance"],
    "build-candidate": ["config", "lint-test", "quality", "security"],
    "build": ["build-candidate"],
    "shadow": ["build"],
    "promote": ["build"],
    "release": ["config", "build"],
    "deploy": ["config", "release"],
    "infra-apply": ["config", "build"],
}
assert set(jobs) == set(expected_needs), f"unexpected jobs: {sorted(jobs)}"
for name, deps in expected_needs.items():
    assert sorted(needs(jobs[name])) == sorted(deps), (
        f"{name}: needs {needs(jobs[name])}"
    )
assert {"lint-test", "quality", "security-assurance", "security"} <= ancestors(
    jobs, "build"
), "stage 4 follows stages 1 to 3"
for later in ["shadow", "promote", "release", "deploy", "infra-apply"]:
    assert "build" in ancestors(jobs, later), f"{later} must follow stage 4"
assert "release" in ancestors(jobs, "deploy"), "stage 7 follows stage 6"
for name in ["lint-test", "quality", "security", "build", "shadow", "promote"]:
    assert jobs[name].get("name", name) == name, (
        f"{name}: the check name must stay pipeline / {name}"
    )

# Conditions.
for name in ["config", "lint-test", "quality", "security-assurance", "build-candidate"]:
    assert "if" not in jobs[name], f"{name} runs on every call"
for name in ["security"]:
    assert (
        jobs[name]["if"] == "${{ !cancelled() && needs.config.result == 'success' }}"
    ), f"{name} reports red, not skipped"
assert "if" not in jobs["build"]
assert "if" not in jobs["build-candidate"]
shadow_if = " ".join(jobs["shadow"]["if"].split())
for clause in [
    "github.event_name == 'pull_request'",
    "github.event.pull_request.base.ref == 'main'",
    "github.event.pull_request.draft == false",
    "github.event.pull_request.head.repo.full_name == github.repository",
]:
    assert clause in shadow_if, f"shadow: missing {clause}"
assert jobs["promote"]["if"] == (
    "github.event_name == 'push' && startsWith(github.ref, 'refs/heads/shadow/pr-')"
)
assert " ".join(jobs["release"]["if"].split()) == (
    "github.event_name == 'push' && (github.ref == 'refs/heads/main' || "
    "startsWith(github.ref, 'refs/tags/v')) && needs.config.outputs.release == 'true'"
)
assert jobs["deploy"]["if"] == (
    "github.ref == 'refs/heads/main' && needs.release.outputs.released == 'true' && needs.config.outputs.deploy_targets != '[]'"
)
assert "needs.config.outputs.ecosystem == 'terraform'" in jobs["infra-apply"]["if"]
assert "refs/heads/main" in jobs["infra-apply"]["if"]
for name in ["shadow", "promote", "release", "deploy", "infra-apply", "build-candidate"]:
    assert not STATUS.search(jobs[name].get("if", "")), (
        f"{name}: a status function would let it run after a failed stage"
    )

# Permissions: the minimum per job.
expected_permissions = {
    "config": {"contents": "read", "id-token": "write"},
    "lint-test": {"contents": "read"},
    "quality": {"contents": "read"},
    "security-assurance": {
        "contents": "read",
        "id-token": "write",
    },
    "security": {"contents": "read"},
    "build-candidate": {"contents": "read"},
    "build": {"contents": "read"},
    "shadow": {"id-token": "write"},
    "promote": {"id-token": "write"},
    "release": {"contents": "write", "id-token": "write", "attestations": "write"},
    "deploy": {},
    "infra-apply": {},
}
for name, job in jobs.items():
    assert job.get("permissions") == expected_permissions[name], (
        f"{name}: permissions {job.get('permissions')}"
    )

# Nested workflows: same-commit local references that exist and accept the inputs and secrets passed.
nested = {
    "security-assurance": "security-assurance.yml",
    "release": "release.yml",
}
for name, job in jobs.items():
    if "uses" not in job:
        assert job["runs-on"] == "ubuntu-24.04", f"{name}: ubuntu-24.04 required"
        assert int(job["timeout-minutes"]) > 0, f"{name}: timeout required"
        continue
    assert LOCAL_WORKFLOW.match(job["uses"]), (
        f"{name}: nested workflow must be ./.github/workflows/<file>"
    )
    assert job["uses"] == f"./.github/workflows/{nested[name]}", (
        f"{name}: calls {job['uses']}"
    )
    target = load(root / ".github/workflows" / nested[name])["on"]["workflow_call"]
    declared = target.get("inputs", {})
    for key in job.get("with", {}):
        assert key in declared, f"{name}: {nested[name]} has no input {key}"
    for key, spec in declared.items():
        if spec.get("required") == "true":
            assert key in job.get("with", {}), f"{name}: required input {key} missing"
    for key in job.get("secrets", {}):
        assert key in target.get("secrets", {}), (
            f"{name}: {nested[name]} has no secret {key}"
        )
    if "depot_ref" in declared:
        assert job["with"]["depot_ref"] == "${{ inputs.depot_ref }}", (
            f"{name}: depot_ref passthrough"
        )
for name in ["security-assurance", "release", "deploy"]:
    assert "secrets" not in jobs[name], f"{name}: no secrets"
assert "secrets." not in text, "the pipeline reads no secret"
assert "uses" not in jobs["deploy"] and "forbidden" in jobs["deploy"]["steps"][0]["run"], (
    "stage 7 fails closed until the authorizer OIDC request exists"
)

# Stage 4: repository code runs only in build-candidate, which holds no OIDC token; build only attests its upload.
assert jobs["build-candidate"]["permissions"] == {"contents": "read"}
for step in jobs["build"]["steps"]:
    uses = step.get("uses", "")
    assert not uses.startswith(("actions/checkout@", "actions/setup-node@")) and uses != INSTALL_TOOL, (
        f"build runs no repository code: {uses}"
    )
    assert not re.search(r"\bnpm\b", step.get("run", "")), "build runs no package code"

# Steps: pinned actions, no credential persistence, no expressions in shell, no eval.
for name, job in jobs.items():
    for index, step in enumerate(job.get("steps", [])):
        where = f"{name} step {index}"
        uses = step.get("uses")
        if uses is not None:
            assert PIN.match(uses) or uses == INSTALL_TOOL, f"{where}: unpinned {uses}"
            if uses.startswith("actions/checkout@"):
                assert step["with"]["persist-credentials"] == "false", (
                    f"{where}: persist-credentials"
                )
        run = step.get("run", "")
        assert "${{" not in run, f"{where}: expression inside run"
        assert not re.search(r"\beval\b", run), f"{where}: eval"

# config binds depot_ref to the pinned commit before any depot code runs.
config_steps = jobs["config"]["steps"]
assert config_steps[0]["id"] == "route"
assert '[ "$DEPOT_REF" = "$PINNED_SHA" ]' in config_steps[1]["run"]
assert config_steps[2]["with"]["ref"] == "${{ inputs.depot_ref }}"
assert "ci/pipeline-config.mjs" in config_steps[-1]["run"]

# Caller template: union of permissions, depot_ref equals the pinned SHA, triggers.
caller = load(caller_path)
job = caller["jobs"]["pipeline"]
sha = job["uses"].rsplit("@", 1)[1]
assert re.fullmatch(r"[0-9a-f]{40}", sha) and job["with"]["depot_ref"] == sha
assert caller["permissions"] == {}
assert set(caller["on"]) == {"pull_request", "push"}
assert caller["on"]["push"]["branches"] == ["main", "shadow/pr-*"]
union = {}
for definition in jobs.values():
    for scope, level in definition.get("permissions", {}).items():
        if union.get(scope) != "write":
            union[scope] = level
assert job["permissions"] == union, (
    f"caller permissions {job['permissions']} != {union}"
)

print(
    "Verified pipeline.yml: config -> lint-test, quality, security-assurance -> security -> build-candidate -> build -> "
    "shadow | promote | release -> deploy | infra-apply; conditions, least-privilege permissions, "
    "pinned uses, same-commit nested workflows, no secrets."
)
