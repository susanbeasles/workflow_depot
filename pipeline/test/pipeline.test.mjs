// Structural contract for pipeline/pipeline.yml and pipeline/caller.yml: the orchestrator of CONTROL-PLANE-SPEC 5.6
// stages 1 to 7, keeping the ADR-0002 section 1 check names. Stage map: docs/pipeline.md.
// YAML is parsed by python3 + PyYAML's BaseLoader (every scalar a string, `on` stays `on`); no npm dependency.
//   node --test pipeline/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed } from '../embed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGED = path.join(ROOT, 'pipeline', 'pipeline.yml');
const CALLER = path.join(ROOT, 'pipeline', 'caller.yml');
const INSTALLED = path.join(ROOT, '.github', 'workflows', 'pipeline.yml');
const POLICY = process.env.AUTHORIZER_POLICY ?? path.resolve(ROOT, '..', 'authorizer', 'policy', 'actions.json');
const SCRIPTS = path.join(ROOT, 'pipeline', 'scripts');

const LOAD = 'import json,sys,yaml\nprint(json.dumps(yaml.load(open(sys.argv[1], encoding="utf-8"), Loader=yaml.BaseLoader)))';
function loadYaml(file) {
  try {
    return JSON.parse(execFileSync('python3', ['-I', '-c', LOAD, file], { encoding: 'utf8' }));
  } catch (error) {
    throw new Error(`cannot parse ${file} with python3 + PyYAML (install python3-yaml): ${error.message}`);
  }
}

const wf = loadYaml(STAGED);
const caller = loadYaml(CALLER);
const raw = readFileSync(STAGED, 'utf8');

// ADR-0002 section 1: these job ids are check names the authorizer reads; their relative order is fixed.
const ADR = {
  'lint-test': [],
  quality: [],
  security: [],
  build: ['lint-test', 'quality', 'security'],
  shadow: ['build'],
  promote: ['build'],
};
// The orchestrator around them: config gates everything, security-assurance feeds the security gate, release
// and deploy follow build, infra-apply is the terraform stage 7.
const NEEDS = {
  config: [],
  'lint-test': ['config'],
  quality: ['config'],
  'security-assurance': ['config'],
  security: ['config', 'security-assurance'],
  build: ['config', 'lint-test', 'quality', 'security'],
  shadow: ['build'],
  promote: ['build'],
  release: ['config', 'build'],
  deploy: ['config', 'release'],
  'infra-apply': ['config', 'build'],
};
// Jobs that call a reusable workflow of this repository at the same commit.
const REUSABLE = {
  'security-assurance': './.github/workflows/security-assurance.yml',
  release: './.github/workflows/release.yml',
  deploy: './.github/workflows/request-deployment.yml',
};
const needsOf = (job) => {
  const n = wf.jobs[job].needs;
  return n === undefined ? [] : Array.isArray(n) ? n : [n];
};
const transitive = (job, seen = new Set()) => {
  for (const dep of needsOf(job)) if (!seen.has(dep)) { seen.add(dep); transitive(dep, seen); }
  return seen;
};
const allSteps = () => Object.entries(wf.jobs).flatMap(([job, def]) => (def.steps ?? []).map((step, i) => ({ job, i, step })));

test('installed .github/workflows/pipeline.yml, when present, is byte for byte the staged file', (t) => {
  if (!existsSync(INSTALLED)) {
    t.skip('.github/workflows/pipeline.yml is not installed yet (see pipeline/README.md)');
    return;
  }
  assert.ok(readFileSync(INSTALLED).equals(readFileSync(STAGED)), '.github/workflows/pipeline.yml differs from pipeline/pipeline.yml: reinstall it with the command in pipeline/README.md');
});

test('reusable workflow only: on workflow_call, permissions {} at top', () => {
  assert.deepEqual(Object.keys(wf.on), ['workflow_call']);
  assert.deepEqual(wf.permissions, {});
  assert.ok(!/pull_request_target/.test(raw), 'pull_request_target must never appear');
});

test('job ids and needs are exactly the orchestrator table, and keep the ADR-0002 order', () => {
  assert.deepEqual(Object.keys(wf.jobs).sort(), Object.keys(NEEDS).sort());
  for (const [job, needs] of Object.entries(NEEDS)) assert.deepEqual(needsOf(job).sort(), [...needs].sort(), `${job} needs`);
  for (const [job, needs] of Object.entries(ADR)) for (const dep of needs) assert.ok(needsOf(job).includes(dep), `${job} must need ${dep} (ADR-0002)`);
});

test('reusable stages call this repository workflows at the same commit, with explicit permissions', () => {
  for (const [job, uses] of Object.entries(REUSABLE)) {
    assert.equal(wf.jobs[job].uses, uses, `${job} uses`);
    assert.ok(existsSync(path.join(ROOT, uses)), `${uses} exists`);
    assert.equal(wf.jobs[job].name, undefined, `${job}: a name would rename every nested check`);
  }
  for (const [job, def] of Object.entries(wf.jobs)) if (def.uses !== undefined) assert.ok(job in REUSABLE, `${job} calls an unexpected workflow`);
  assert.deepEqual(wf.jobs['security-assurance'].with, {
    depot_repository: 'susanbeasles/workflow_depot',
    depot_ref: '${{ inputs.depot_ref }}',
    policy_profile: '${{ needs.config.outputs.policy_profile }}',
  });
  assert.deepEqual(wf.jobs.release.with, { depot_ref: '${{ inputs.depot_ref }}', application_manifest: '${{ needs.config.outputs.application_manifest }}' });
  assert.deepEqual(wf.jobs.deploy.with, { target: '${{ matrix.target }}', depot_ref: '${{ inputs.depot_ref }}' });
  assert.deepEqual(wf.jobs.deploy.secrets, { RELEASE_DISPATCH_TOKEN: '${{ secrets.RELEASE_DISPATCH_TOKEN }}' });
  assert.equal(wf.jobs.deploy.strategy.matrix.target, '${{ fromJSON(needs.config.outputs.deploy_targets) }}');
  for (const job of ['security-assurance', 'release']) assert.equal(wf.jobs[job].secrets, undefined, `${job} receives no secrets`);
  assert.ok(!/secrets:\s*inherit/.test(raw), 'secrets: inherit is forbidden');
});

test('job names, when set, equal the job id (the check name is `pipeline / <id>`)', () => {
  for (const [job, def] of Object.entries(wf.jobs)) if (def.name !== undefined) assert.equal(def.name, job);
});

test('every job: explicit minimal permissions; every runner job ubuntu-24.04 with timeout-minutes', () => {
  const allowed = {
    config: { contents: 'read', 'id-token': 'write' },
    'lint-test': { contents: 'read' },
    quality: { contents: 'read' },
    'security-assurance': { contents: 'read', 'security-events': 'write', 'id-token': 'write' },
    security: { contents: 'read' },
    build: { contents: 'read', 'id-token': 'write', attestations: 'write' },
    shadow: { 'id-token': 'write' },
    promote: { 'id-token': 'write' },
    release: { contents: 'write', 'id-token': 'write', attestations: 'write' },
    deploy: { contents: 'read' },
    'infra-apply': {},
  };
  for (const [job, def] of Object.entries(wf.jobs)) {
    assert.deepEqual(def.permissions, allowed[job], `${job} permissions`);
    if (def.uses !== undefined) continue;
    assert.equal(def['runs-on'], 'ubuntu-24.04', `${job} runs-on`);
    assert.match(String(def['timeout-minutes'] ?? ''), /^[1-9][0-9]?$/, `${job} timeout-minutes`);
  }
});

// The one local action: security-assurance's qualified tool installer, from the workflow_depot checkout at depot_ref.
const INSTALL_TOOL = './.security-depot/.github/actions/install-tool';

test('every uses: is pinned to a full 40-hex SHA with a version comment, or is a file of this same commit', () => {
  const lines = [...raw.split('\n'), ...readFileSync(CALLER, 'utf8').split('\n')].filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.ok(lines.length > 0);
  for (const line of lines) {
    if (/^ {4}uses: \.\/\.github\/workflows\/[a-z-]+\.yml$/.test(line) || line.trim() === `uses: ${INSTALL_TOOL}`) continue;
    assert.match(line, /uses: [A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40} # \S/, line);
  }
  for (const { job, step } of allSteps()) if (step.uses !== undefined) assert.ok((!step.uses.startsWith('./') || step.uses === INSTALL_TOOL) && !step.uses.startsWith('docker://'), `${job}: ${step.uses}`);
});

test('only the allowed actions are used', () => {
  const ok = new Set(['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/attest-build-provenance', INSTALL_TOOL]);
  for (const { job, step } of allSteps()) if (step.uses !== undefined) assert.ok(ok.has(step.uses.split('@')[0]), `${job}: ${step.uses}`);
  const tools = allSteps().filter(({ step }) => step.uses === INSTALL_TOOL);
  assert.deepEqual(tools.map(({ job, step }) => [job, step.with.tool]), [['build', 'syft']]);
});

test('every checkout sets persist-credentials: false', () => {
  const checkouts = allSteps().filter(({ step }) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkouts.length >= 9);
  for (const { job, step } of checkouts) assert.equal(step.with?.['persist-credentials'], 'false', `${job} checkout`);
});

test('no ${{ }} expression inside any run: block (template injection)', () => {
  for (const { job, i, step } of allSteps()) if (step.run !== undefined) {
    assert.ok(!step.run.includes('${{'), `${job} step ${i} interpolates into run:`);
    assert.ok(!/inputs\./.test(step.run), `${job} step ${i} references inputs. in run:`);
  }
});

test('inputs: depot_ref and require-attestation only; one optional named secret', () => {
  const call = wf.on.workflow_call;
  assert.deepEqual(Object.keys(call.inputs).sort(), ['depot_ref', 'require-attestation']);
  assert.equal(call.inputs.depot_ref.required, 'true');
  assert.equal(call.inputs.depot_ref.type, 'string');
  assert.equal(call.inputs['require-attestation'].type, 'boolean');
  assert.equal(call.inputs['require-attestation'].default, 'true');
  assert.deepEqual(Object.keys(call.secrets), ['RELEASE_DISPATCH_TOKEN']);
  assert.equal(call.secrets.RELEASE_DISPATCH_TOKEN.required, 'false');
  assert.equal(call.outputs.released.value, '${{ jobs.release.outputs.released }}');
  assert.equal(call.outputs.release_tag.value, '${{ jobs.release.outputs.releaseTag }}');
});

test('config: depot_ref must equal the pinned SHA before pipeline.json is read and validated', () => {
  const steps = wf.jobs.config.steps;
  assert.equal(steps[0].id, 'route');
  assert.equal(steps[0].run, readFileSync(path.join(SCRIPTS, 'workflow-sha.cjs'), 'utf8'));
  assert.deepEqual(steps[1].env, { DEPOT_REF: '${{ inputs.depot_ref }}', PINNED_SHA: '${{ steps.route.outputs.sha }}' });
  assert.match(steps[1].run, /\[ "\$DEPOT_REF" = "\$PINNED_SHA" \]/);
  assert.match(steps[1].run, /\^\[0-9a-f\]\{40\}\$/);
  assert.equal(steps[2].with.repository, 'susanbeasles/workflow_depot');
  assert.equal(steps[2].with.ref, '${{ inputs.depot_ref }}');
  assert.equal(steps[3].with['sparse-checkout'], '/pipeline.json');
  assert.equal(steps[3].with.repository, undefined, 'pipeline.json comes from the calling repository');
  assert.equal(steps[4].id, 'read');
  assert.match(steps[4].run, /node \.workflow-depot\/ci\/pipeline-config\.mjs --app-root src --config pipeline\.json --github-output "\$GITHUB_OUTPUT"/);
  for (const [key, value] of Object.entries(wf.jobs.config.outputs)) assert.equal(value, `\${{ steps.read.outputs.${key} }}`, key);
});

test('repository commands are npm script names from validated config outputs, run without eval', () => {
  assert.ok(!/\beval\b/.test(raw), 'no eval anywhere');
  const runs = { 'lint-test': ['script_lint', 'script_typecheck', 'script_test'], build: ['script_build'] };
  for (const [job, outputs] of Object.entries(runs)) {
    for (const output of outputs) {
      const step = wf.jobs[job].steps.find((s) => s.env?.SCRIPT === `\${{ needs.config.outputs.${output} }}`);
      assert.ok(step, `${job} runs ${output}`);
      assert.equal(step.run, 'npm run "$SCRIPT"');
    }
  }
  for (const job of ['lint-test', 'build']) {
    const install = wf.jobs[job].steps.find((s) => s.name === 'Install');
    assert.match(install.run, /^set -euo pipefail\nnpm ci --ignore-scripts --no-audit --no-fund\n/);
    assert.equal(install.env.REBUILD, '${{ needs.config.outputs.rebuild }}');
    assert.match(install.run, /npm rebuild "\$\{packages\[@\]\}" --ignore-scripts=false/);
    assert.equal(wf.jobs[job].defaults.run['working-directory'], '${{ needs.config.outputs.working_directory }}');
  }
  const coverage = wf.jobs['lint-test'].steps.find((s) => s.name === 'Coverage');
  assert.equal(coverage.run, readFileSync(path.join(SCRIPTS, 'coverage-check.cjs'), 'utf8'));
  assert.deepEqual(coverage.env, { COVERAGE_SUMMARY: '${{ needs.config.outputs.coverage_summary }}', COVERAGE_MIN: '${{ needs.config.outputs.coverage_min }}' });
  const steps = wf.jobs['lint-test'].steps.map((s) => s.name ?? s.uses.split('@')[0]);
  assert.deepEqual(steps.slice(-4), ['Lint', 'Typecheck', 'Test', 'Coverage'], 'coverage is checked after the tests');
});

test('terraform: stage 1, stage 4 and stage 7 fail closed until their requests exist', () => {
  for (const job of ['lint-test', 'build']) {
    const first = wf.jobs[job].steps[0];
    assert.equal(first.if, "needs.config.outputs.ecosystem == 'terraform'", `${job} first step`);
    assert.match(first.run, /exit 1\n$/);
  }
  const apply = wf.jobs['infra-apply'];
  assert.equal(apply.if, "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.config.outputs.ecosystem == 'terraform'");
  assert.equal(apply.steps.length, 1);
  assert.match(apply.steps[0].run, /exit 1\n$/);
});

test('shadow runs only for pull_request into main; promote only for push to shadow/pr-*', () => {
  const shadow = wf.jobs.shadow.if.replace(/\s+/g, ' ');
  assert.match(shadow, /github\.event_name == 'pull_request'/);
  assert.match(shadow, /github\.event\.pull_request\.base\.ref == 'main'/);
  assert.ok(!/push/.test(shadow));
  assert.equal(wf.jobs.promote.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/heads/shadow/pr-')");
  for (const name of ['config', 'lint-test', 'quality', 'security-assurance', 'build']) assert.equal(wf.jobs[name].if, undefined, `${name} runs on every call`);
  assert.equal(wf.jobs.security.if, "${{ !cancelled() && needs.config.result == 'success' }}", 'security reports red, not skipped, when security-assurance fails');
  assert.equal(wf.jobs.security.steps[0].env.DECISION, '${{ needs.security-assurance.outputs.decision }}');
  assert.match(wf.jobs.security.steps[0].run, /if \[ "\$DECISION" != PASS \]; then/);
});

test('release runs only on main and vX.Y.Z pushes after build; deploy only after a published release', () => {
  assert.equal(
    wf.jobs.release.if.replace(/\s+/g, ' ').trim(),
    "github.event_name == 'push' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')) && needs.config.outputs.release == 'true'",
  );
  assert.equal(wf.jobs.deploy.if, "needs.release.outputs.released == 'true' && needs.config.outputs.deploy_targets != '[]'");
  for (const job of ['release', 'deploy', 'shadow', 'promote', 'infra-apply']) assert.ok(!/always\(\)|failure\(\)|cancelled\(\)/.test(wf.jobs[job].if), `${job} keeps the implicit success() of its needs`);
});

test('shadow and promote run the request actions at the workflow_depot commit pipeline.yml runs at', () => {
  for (const [job, action] of [['shadow', 'request-shadow'], ['promote', 'request-promotion']]) {
    const steps = wf.jobs[job].steps;
    assert.equal(steps.length, 3, `${job} steps`);
    assert.equal(steps[0].id, 'route');
    assert.equal(steps[0].shell, 'node {0}');
    assert.equal(steps[0].run, readFileSync(path.join(SCRIPTS, 'workflow-sha.cjs'), 'utf8'));
    assert.equal(steps[1].with.repository, 'susanbeasles/workflow_depot');
    assert.equal(steps[1].with.ref, '${{ steps.route.outputs.sha }}');
    assert.equal(steps[1].with.path, '.workflow-depot');
    assert.equal(steps[2].env.DEPOT_SHA, '${{ steps.route.outputs.sha }}');
    assert.match(steps[2].run, /git -C \.workflow-depot rev-parse HEAD\)" = "\$DEPOT_SHA"/);
    assert.match(steps[2].run, new RegExp(`node \\.workflow-depot/actions/${action}/main\\.mjs`));
  }
  assert.equal(wf.jobs.promote.steps[2].env.INPUT_ARTIFACT_DIGEST, '${{ needs.build.outputs.artifact_digest }}');
});

test('build outputs artifact_digest, uploads it and attests it', () => {
  const build = wf.jobs.build;
  assert.equal(build.outputs.artifact_digest, '${{ steps.package.outputs.artifact_digest }}');
  assert.equal(wf.on.workflow_call.outputs.artifact_digest.value, '${{ jobs.build.outputs.artifact_digest }}');
  const attest = build.steps.find((s) => s.uses?.startsWith('actions/attest-build-provenance@'));
  assert.equal(attest.with['subject-path'], '${{ steps.package.outputs.artifact_file }}');
  assert.equal(attest.if, 'inputs.require-attestation');
  const upload = build.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.path, '${{ steps.package.outputs.artifact_file }}');
  assert.equal(build.steps.find((s) => s.id === 'package').env.ARTIFACT_PATH, '${{ needs.config.outputs.output_directory }}');
  const verify = build.steps.find((s) => s.name?.startsWith('Verify the attestation'));
  assert.equal(verify.if, 'inputs.require-attestation');
  assert.match(verify.run, /gh attestation verify "\$ARTIFACT_FILE" --repo "\$GITHUB_REPOSITORY"/);
  assert.match(verify.run, /--cert-identity "https:\/\/github\.com\/susanbeasles\/workflow_depot\/\.github\/workflows\/pipeline\.yml@\$DEPOT_REF"/);
  assert.ok(build.steps.indexOf(verify) > build.steps.indexOf(attest), 'verify after attest');
  const sbom = build.steps.find((s) => s.name?.startsWith('SBOM'));
  assert.match(sbom.run, /cyclonedx-json=/);
  assert.match(sbom.run, /spdx-json=/);
  assert.equal(upload.with['if-no-files-found'], 'error');
  for (const s of build.steps) if (s.uses?.startsWith('actions/setup-node@')) assert.equal(s.with['package-manager-cache'], 'false');
  assert.ok(!build.steps.some((s) => s.with?.cache), 'no dependency cache in the attested build');
});

test('quality and security run their tools from pinned, checksum-verified downloads', () => {
  const installs = allSteps().filter(({ step }) => /^Install (actionlint|gitleaks)/.test(step.name ?? ''));
  assert.equal(installs.length, 2);
  for (const { step } of installs) {
    assert.match(step.run, /sha256sum -c -/);
    for (const [key, value] of Object.entries(step.env)) if (key.endsWith('SHA256')) assert.match(value, /^[0-9a-f]{64}$/, key);
  }
  const run = (job, name) => wf.jobs[job].steps.find((s) => s.name === name).run;
  assert.match(run('quality', 'zizmor'), /--no-config/);
  assert.match(run('quality', 'actionlint'), /-config-file "\$RUNNER_TEMP\/actionlint\.yaml"/);
  assert.match(run('security', 'gitleaks (checkout and commit range)'), /--config "\$cfg"/);
});

test('every embedded step is byte for byte its pipeline/scripts file, and every script is embedded', () => {
  const scripts = readdirSync(SCRIPTS).filter((f) => f.endsWith('.cjs'));
  const embedded = new Set();
  for (const { job, i, step } of allSteps()) {
    if (step.shell !== 'node {0}') continue;
    const match = scripts.find((f) => step.run === readFileSync(path.join(SCRIPTS, f), 'utf8'));
    assert.ok(match, `${job} step ${i} (shell: node {0}) is not a copy of any pipeline/scripts file: run \`node pipeline/embed.mjs\``);
    embedded.add(match);
  }
  assert.deepEqual([...embedded].sort(), scripts.sort());
  assert.equal(embed(raw, (rel) => readFileSync(path.join(ROOT, rel), 'utf8')), raw, 'pipeline.yml is out of date: run `node pipeline/embed.mjs`');
});

test('caller template: triggers, permissions {}, job id pipeline, depot_ref equal to the pinned SHA', () => {
  assert.deepEqual(caller.on.pull_request.branches, ['main']);
  assert.ok(caller.on.pull_request.types.includes('ready_for_review'));
  assert.deepEqual(caller.on.push.branches, ['main', 'shadow/pr-*']);
  assert.deepEqual(caller.on.push.tags, ['v*.*.*']);
  assert.deepEqual(Object.keys(caller.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(caller.permissions, {});
  assert.match(caller.concurrency.group, /\$\{\{ github\.ref \}\}/);
  assert.match(caller.concurrency['cancel-in-progress'], /github\.ref != 'refs\/heads\/main' && !startsWith\(github\.ref, 'refs\/tags\/'\)/, 'never cancel a main or tag run mid-release');
  assert.deepEqual(Object.keys(caller.jobs), ['pipeline']);
  const job = caller.jobs.pipeline;
  assert.equal(job.name, undefined, 'a name on the calling job would change every check name');
  const pinned = /^susanbeasles\/workflow_depot\/\.github\/workflows\/pipeline\.yml@([0-9a-f]{40})$/.exec(job.uses);
  assert.ok(pinned, job.uses);
  assert.deepEqual(job.with, { depot_ref: pinned[1] });
  assert.deepEqual(job.secrets, { RELEASE_DISPATCH_TOKEN: '${{ secrets.RELEASE_DISPATCH_TOKEN }}' });
  // The union of what the jobs inside declare; each job keeps only its own grant.
  assert.deepEqual(job.permissions, { contents: 'write', 'id-token': 'write', attestations: 'write', 'security-events': 'write' });
  const union = {};
  const rank = { read: 1, write: 2 };
  for (const def of Object.values(wf.jobs)) for (const [scope, level] of Object.entries(def.permissions ?? {})) if ((rank[level] ?? 0) > (rank[union[scope]] ?? 0)) union[scope] = level;
  assert.deepEqual(job.permissions, union);
  assert.ok(readFileSync(CALLER, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).length <= 12, 'the caller stays about ten lines');
  const body = readFileSync(CALLER, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
  for (const doc of ['docs/pipeline.md', 'docs/PROMOTION.md']) assert.ok(readFileSync(path.join(ROOT, doc), 'utf8').includes(`\`\`\`yaml\n${body}\`\`\``), `${doc} shows pipeline/caller.yml`);
});

test('check names the pipeline implies equal the names the authorizer policy requires', (t) => {
  if (!existsSync(POLICY)) {
    t.skip(`authorizer policy not found at ${POLICY} (set AUTHORIZER_POLICY to check it)`);
    return;
  }
  const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
  const name = (job) => `pipeline / ${job}`;
  // Only the ADR-0002 jobs are evidence. config and security-assurance gate them transitively, and a job that
  // calls a reusable workflow has no check of its own.
  const implied = new Set(Object.keys(ADR).map(name));
  const PATH = 'susanbeasles/workflow_depot/.github/workflows/pipeline.yml';
  // ADR-0002 2.3: lint-test, quality, security and build, for both shadow.prepare and promote.
  const actions = { 'shadow.prepare': 'shadow', promote: 'promote' };
  const checkRequired = (where, got, job) => {
    for (const check of got) assert.ok(implied.has(check), `${where}: ${check} is not a pipeline check`);
    assert.ok(!got.includes(name(job)), `${where} requires its own job`);
    assert.deepEqual([...got].sort(), [...transitive(job)].filter((dep) => dep in ADR).map(name).sort(), where);
  };
  if (policy.required_jobs !== undefined) {
    // authorizer-policy with one job contract: pipeline_workflow + required_jobs.
    assert.equal(policy.pipeline_workflow?.path, PATH);
    assert.deepEqual(Object.keys(policy.required_jobs).sort(), Object.keys(actions).sort());
    for (const [action, job] of Object.entries(actions)) {
      const rule = policy.required_jobs[action];
      assert.equal(rule.requesting_job, name(job), `required_jobs.${action}.requesting_job`);
      checkRequired(`required_jobs.${action}.completed_jobs`, rule.completed_jobs ?? [], job);
    }
    return;
  }
  // Earlier layout: per-rule required_pr_checks / required_candidate_checks.
  assert.equal(policy.workflows?.pipeline?.path, PATH);
  const fields = { 'shadow.prepare': 'required_pr_checks', promote: 'required_candidate_checks' };
  for (const [action, job] of Object.entries(actions)) {
    const rules = (policy.actions?.[action] ?? []).filter((rule) => rule.workflow === 'pipeline');
    assert.ok(rules.length > 0, `policy has no ${action} rule for the pipeline`);
    for (const rule of rules) checkRequired(`${action} ${rule.repo} ${fields[action]}`, rule[fields[action]] ?? [], job);
  }
});
