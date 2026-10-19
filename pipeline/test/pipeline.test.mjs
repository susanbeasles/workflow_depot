// Structural contract for pipeline/pipeline.yml and pipeline/caller.yml (infra-root ADR-0002 section 1).
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

// ADR-0002 section 1, exactly.
const ADR = {
  'lint-test': [],
  quality: [],
  security: [],
  'build-candidate': ['lint-test', 'quality', 'security'],
  build: ['build-candidate'],
  shadow: ['build'],
  promote: ['build'],
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

test('job ids and needs are exactly the ADR-0002 table', () => {
  assert.deepEqual(Object.keys(wf.jobs).sort(), Object.keys(ADR).sort());
  for (const [job, needs] of Object.entries(ADR)) assert.deepEqual(needsOf(job).sort(), [...needs].sort(), `${job} needs`);
});

test('job names, when set, equal the job id (the check name is `pipeline / <id>`)', () => {
  for (const [job, def] of Object.entries(wf.jobs)) if (def.name !== undefined) assert.equal(def.name, job);
});

test('every job: ubuntu-24.04, timeout-minutes, explicit minimal permissions', () => {
  const allowed = {
    'lint-test': { contents: 'read' },
    quality: { contents: 'read' },
    security: { contents: 'read' },
    'build-candidate': { contents: 'read' },
    build: { contents: 'read' },
    shadow: { 'id-token': 'write' },
    promote: { 'id-token': 'write' },
  };
  for (const [job, def] of Object.entries(wf.jobs)) {
    assert.equal(def['runs-on'], 'ubuntu-24.04', `${job} runs-on`);
    assert.match(String(def['timeout-minutes'] ?? ''), /^[1-9][0-9]?$/, `${job} timeout-minutes`);
    assert.deepEqual(def.permissions, allowed[job], `${job} permissions`);
  }
});

test('every uses: is pinned to a full 40-hex SHA with a version comment', () => {
  const lines = [...raw.split('\n'), ...readFileSync(CALLER, 'utf8').split('\n')].filter((l) => /^\s*-?\s*uses:/.test(l));
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /uses: [A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40} # \S/, line);
  for (const { job, step } of allSteps()) if (step.uses !== undefined) assert.ok(!step.uses.startsWith('./') && !step.uses.startsWith('docker://'), `${job}: ${step.uses}`);
});

test('only the allowed actions are used', () => {
  const ok = new Set(['actions/checkout', 'actions/setup-node', 'actions/upload-artifact', 'actions/download-artifact']);
  for (const { job, step } of allSteps()) if (step.uses !== undefined) assert.ok(ok.has(step.uses.split('@')[0]), `${job}: ${step.uses}`);
});

test('every checkout sets persist-credentials: false', () => {
  const checkouts = allSteps().filter(({ step }) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkouts.length >= 6);
  for (const { job, step } of checkouts) assert.equal(step.with?.['persist-credentials'], 'false', `${job} checkout`);
});

test('no ${{ }} expression inside any run: block (template injection)', () => {
  for (const { job, i, step } of allSteps()) if (step.run !== undefined) {
    assert.ok(!step.run.includes('${{'), `${job} step ${i} interpolates into run:`);
    assert.ok(!/inputs\./.test(step.run), `${job} step ${i} references inputs. in run:`);
  }
});

test('caller commands reach the shell only through env and are run, not interpolated', () => {
  const commands = ['install', 'lint', 'typecheck', 'test', 'build'];
  for (const name of commands) {
    const steps = allSteps().filter(({ step }) => step.env?.CMD === `\${{ inputs.${name} }}`);
    assert.ok(steps.length >= 1, `${name} is run somewhere`);
    for (const { step } of steps) assert.match(step.run, /eval "\$CMD"/);
  }
  const inputs = wf.on.workflow_call.inputs;
  assert.equal(inputs['node-version'].default, '24');
  assert.equal(inputs['working-directory'].default, '.');
  assert.equal(inputs.install.default, 'npm ci --ignore-scripts');
  assert.equal(inputs.lint.default, 'npm run lint --if-present');
  assert.equal(inputs.typecheck.default, 'npm run typecheck --if-present');
  assert.equal(inputs.test.default, 'npm test');
  assert.equal(inputs.build.default, 'npm run build --if-present');
  assert.equal(inputs['artifact-path'].default, '');
  assert.equal(inputs['require-attestation'], undefined, 'no GitHub attestations');
});

test('shadow runs only for pull_request into main; promote only for push to shadow/pr-*', () => {
  const shadow = wf.jobs.shadow.if.replace(/\s+/g, ' ');
  assert.match(shadow, /github\.event_name == 'pull_request'/);
  assert.match(shadow, /github\.event\.pull_request\.base\.ref == 'main'/);
  assert.ok(!/push/.test(shadow));
  assert.equal(wf.jobs.promote.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/heads/shadow/pr-')");
  for (const name of ['lint-test', 'quality', 'security', 'build']) assert.equal(wf.jobs[name].if, undefined, `${name} runs on every call`);
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

test('build outputs an independently computed artifact_digest and creates no GitHub attestation', () => {
  const build = wf.jobs.build;
  assert.equal(build.outputs.artifact_digest, '${{ steps.digest.outputs.artifact_digest }}');
  assert.equal(wf.on.workflow_call.outputs.artifact_digest.value, '${{ jobs.build.outputs.artifact_digest }}');
  assert.ok(!build.steps.some((s) => s.uses?.startsWith('actions/attest')), 'no GitHub attestation step');
  assert.deepEqual(build.permissions, { contents: 'read' });
  const candidate = wf.jobs['build-candidate'];
  const upload = candidate.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.path, '${{ steps.package.outputs.artifact_file }}');
  assert.equal(upload.with['if-no-files-found'], 'error');
  for (const s of candidate.steps) if (s.uses?.startsWith('actions/setup-node@')) assert.equal(s.with['package-manager-cache'], 'false');
  assert.ok(!build.steps.some((s) => s.with?.cache), 'no dependency cache in the released build');
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

test('caller template: triggers, permissions {}, job id pipeline at a pinned SHA, concurrency per ref', () => {
  assert.deepEqual(caller.on.pull_request.branches, ['main']);
  assert.ok(caller.on.pull_request.types.includes('ready_for_review'));
  assert.deepEqual(caller.on.push.branches, ['shadow/pr-*']);
  assert.deepEqual(Object.keys(caller.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(caller.permissions, {});
  assert.match(caller.concurrency.group, /\$\{\{ github\.ref \}\}/);
  assert.deepEqual(Object.keys(caller.jobs), ['pipeline']);
  const job = caller.jobs.pipeline;
  assert.equal(job.name, undefined, 'a name on the calling job would change every check name');
  assert.match(job.uses, /^susanbeasles\/workflow_depot\/\.github\/workflows\/pipeline\.yml@[0-9a-f]{40}$/);
  assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' });
});

test('check names the pipeline implies equal the names the authorizer policy requires', (t) => {
  if (!existsSync(POLICY)) {
    t.skip(`authorizer policy not found at ${POLICY} (set AUTHORIZER_POLICY to check it)`);
    return;
  }
  const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
  const name = (job) => `pipeline / ${job}`;
  const implied = new Set(Object.keys(wf.jobs).map(name));
  const PATH = 'susanbeasles/workflow_depot/.github/workflows/pipeline.yml';
  // ADR-0002 2.3: lint-test, quality, security and build, for both shadow.prepare and promote.
  const actions = { 'shadow.prepare': 'shadow', promote: 'promote' };
  const checkRequired = (where, got, job) => {
    for (const check of got) assert.ok(implied.has(check), `${where}: ${check} is not a pipeline check`);
    assert.ok(!got.includes(name(job)), `${where} requires its own job`);
    assert.deepEqual([...got].sort(), [...transitive(job)].map(name).sort(), where);
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
