import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const workflow = await readFile(new URL('../.github/workflows/request-release.yml', import.meta.url), 'utf8');
const candidateWorkflow = await readFile(new URL('../.github/workflows/validate-controller.yml', import.meta.url), 'utf8');
const scripts = [...workflow.matchAll(/^([ ]*)node --input-type=module <<'JS'\n([\s\S]*?)^\1JS$/gm)];
assert.equal(scripts.length, 1, 'exercise exactly the inline JavaScript shipped in the reusable workflow');
const script = scripts[0][2];
const token = 'synthetic-test-token-do-not-log';
const valid = Object.freeze({
  GH_TOKEN: token,
  SOURCE_REPOSITORY: 'susanbeasles/synthetic-repository',
  SOURCE_REPOSITORY_ID: '123456789',
  SOURCE_SHA: '0123456789abcdef0123456789abcdef01234567',
  SOURCE_RUN_ID: '987654321',
  SOURCE_OWNER_ID: '215839550',
  SOURCE_EVENT: 'push',
  SOURCE_REF: 'refs/heads/main',
});

async function execute(overrides = {}, respond = async () => ({ ok: true, status: 204 })) {
  const requests = [], logs = [], timeouts = [];
  const context = {
    process: { env: { ...valid, ...overrides } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return respond(url, options);
    },
    AbortSignal: { timeout: ms => { timeouts.push(ms); return 'synthetic-abort-signal'; } },
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map(method => [method, (...args) => logs.push(args.join(' '))])),
  };
  let error;
  try {
    await vm.runInNewContext(`(async () => {\n${script}\n})()`, context, { timeout: 1000 });
  } catch (caught) { error = caught; }
  assert.ok(!JSON.stringify(logs).includes(token), 'synthetic dispatch credential must not be logged');
  assert.ok(!String(error?.message ?? '').includes(token), 'errors must not expose the dispatch credential');
  return { requests, logs, timeouts, error };
}

test('dispatches the exact caller identity to the fixed central receiver', async () => {
  const result = await execute({
    // These are not caller inputs and must not redirect dispatch authority.
    TARGET_REPOSITORY: 'different-owner/untrusted', TARGET_REF: 'untrusted', TARGET_WORKFLOW: 'other.yml',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.requests.length, 1);
  const { url, options } = result.requests[0];
  assert.equal(url, 'https://api.github.com/repos/susanbeasles/delivery_control/actions/workflows/release.yml/dispatches');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.signal, 'synthetic-abort-signal');
  assert.deepEqual(result.timeouts, [30000]);
  assert.deepEqual(JSON.parse(options.body), {
    ref: 'main',
    inputs: { repository: valid.SOURCE_REPOSITORY, repository_id: valid.SOURCE_REPOSITORY_ID, sha: valid.SOURCE_SHA, source_run_id: valid.SOURCE_RUN_ID },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(options.headers)), {
    Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json',
  });
  assert.ok(!options.body.includes(token));
  assert.deepEqual(result.logs, ['Release request accepted by delivery_control']);
});

for (const [name, overrides] of [
  ['wrong numeric owner', { SOURCE_OWNER_ID: '215839551' }],
  ['missing numeric owner', { SOURCE_OWNER_ID: undefined }],
  ['pull request', { SOURCE_EVENT: 'pull_request' }],
  ['manual dispatch', { SOURCE_EVENT: 'workflow_dispatch' }],
  ['feature branch', { SOURCE_REF: 'refs/heads/feature' }],
  ['main tag', { SOURCE_REF: 'refs/tags/main' }],
  ['other repository owner', { SOURCE_REPOSITORY: 'other-owner/synthetic-repository' }],
  ['repository path suffix', { SOURCE_REPOSITORY: 'susanbeasles/synthetic-repository/extra' }],
  ['missing repository', { SOURCE_REPOSITORY: undefined }],
  ['short SHA', { SOURCE_SHA: '0123456' }],
  ['symbolic SHA', { SOURCE_SHA: 'main' }],
  ['uppercase SHA', { SOURCE_SHA: 'A'.repeat(40) }],
  ['missing dispatch credential', { GH_TOKEN: undefined }],
  ['empty dispatch credential', { GH_TOKEN: '' }],
]) {
  test(`rejects ${name} before any network request`, async () => {
    const result = await execute(overrides);
    assert.ok(result.error, 'invalid caller must fail');
    assert.equal(result.requests.length, 0);
    assert.deepEqual(result.logs, []);
  });
}

for (const field of ['SOURCE_REPOSITORY_ID', 'SOURCE_RUN_ID']) {
  test(`${field} rejects identities that the receiver cannot represent exactly`, async () => {
    for (const value of [undefined, '', '0', '-1', '01', '1.5', '1e3', ' 1', '9007199254740992', '9'.repeat(400)]) {
      const result = await execute({ [field]: value });
      assert.ok(result.error, `${field}=${value} must fail before dispatch`);
      assert.equal(result.requests.length, 0);
    }
    const result = await execute({ [field]: String(Number.MAX_SAFE_INTEGER) });
    assert.equal(result.error, undefined);
    assert.equal(result.requests.length, 1);
    assert.equal(JSON.parse(result.requests[0].options.body).inputs[field === 'SOURCE_REPOSITORY_ID' ? 'repository_id' : 'source_run_id'], '9007199254740991');
  });
}

test('HTTP failure logs no response body, reports no success, and performs no automatic retry', async () => {
  let bodyReads = 0;
  const result = await execute({}, async () => ({
    ok: false, status: 403,
    text() { bodyReads++; throw Error(token); }, json() { bodyReads++; throw Error(token); },
  }));
  assert.match(result.error?.message ?? '', /^Release dispatch failed \(403\); rerun this source workflow$/);
  assert.equal(result.requests.length, 1);
  assert.equal(bodyReads, 0);
  assert.deepEqual(result.logs, []);
});

test('ambiguous network failure performs no automatic retry or success logging', async () => {
  const result = await execute({}, async () => { throw Error('synthetic connection closed'); });
  assert.ok(result.error);
  assert.equal(result.requests.length, 1);
  assert.deepEqual(result.logs, []);
});

test('workflow passes GitHub caller context through environment without executing caller source', () => {
  for (const [name, expression] of Object.entries({
    GH_TOKEN: 'secrets.RELEASE_DISPATCH_TOKEN', SOURCE_REPOSITORY: 'github.repository',
    SOURCE_REPOSITORY_ID: 'github.repository_id', SOURCE_SHA: 'github.sha', SOURCE_RUN_ID: 'github.run_id',
    SOURCE_OWNER_ID: 'github.repository_owner_id', SOURCE_EVENT: 'github.event_name', SOURCE_REF: 'github.ref',
  })) assert.ok(workflow.includes(name + ': ${{ ' + expression + ' }}'));
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /^  workflow_call:\n    secrets:\n      RELEASE_DISPATCH_TOKEN:\n        required: true$/m);
  assert.doesNotMatch(script, /\$\{\{/);
  assert.doesNotMatch(workflow, /\buses:|secrets: inherit|contents: write|id-token: write/);
});

test('candidate validation checks a full SHA before pinned checkout with read-only authority', () => {
  const guard = candidateWorkflow.indexOf("run: '[[ \"$CANDIDATE\" =~ ^[a-f0-9]{40}$ ]]'");
  const checkout = candidateWorkflow.indexOf('- uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803');
  assert.ok(guard >= 0 && checkout > guard);
  assert.match(candidateWorkflow, /^permissions: \{\}$/m);
  assert.match(candidateWorkflow, /^      contents: read$/m);
  assert.match(candidateWorkflow, /ref: \$\{\{ inputs\.candidate_sha \}\}\n          persist-credentials: false/);
  assert.match(candidateWorkflow, /run: node --test controller\/test\/\*\.test\.mjs/);
  assert.doesNotMatch(candidateWorkflow, /secrets[.:]|contents: write|id-token: write/);
});
