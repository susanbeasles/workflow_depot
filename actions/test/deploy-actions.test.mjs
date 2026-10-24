import test from 'node:test';
import assert from 'node:assert/strict';
import { main, requestFromEnvironment } from '../request-deploy/main.mjs';

const ID = '019a0f00-0000-7000-8000-000000000001';
const SHA = 'a'.repeat(40), DIGEST = 'b'.repeat(64);
const env = {
  GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: SHA,
  GITHUB_REPOSITORY: 'susanbeasles/example', GITHUB_REPOSITORY_ID: '123',
  INPUT_APPLICATION: 'example', INPUT_ENVIRONMENT: 'production', INPUT_TARGETS: '["worker"]',
  INPUT_RELEASE_TAG: 'v1.2.3', INPUT_MANIFEST_SHA256: DIGEST,
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token?existing=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-bearer',
};
const status = overrides => ({ schema: 'deployment-state/v1', deploymentId: ID, application: 'example', environment: 'production', intent: 'deploy', requestedReleaseTag: 'v1.2.3', sourceCommit: SHA, requestedManifestSha256: DIGEST, phase: 'SUCCEEDED', completedTargets: [{ id: 'worker', versionId: 'version-1' }], ...overrides });
function fixture({ admission = { status: 'QUEUED', deploymentId: ID, githubDeploymentId: 7 }, http = 202, replies = [status()], throwAdmission = false } = {}) {
  const calls = []; let tokens = 0, index = 0;
  const fetcher = async (url, init) => {
    const target = new URL(url); calls.push({ url: target, init });
    if (target.hostname === 'oidc.example') return Response.json({ value: `header.payload.signature${++tokens}` });
    assert.equal(target.href, 'https://services.susanb.dev/v1/token');
    const request = JSON.parse(init.body);
    if (request.action === 'deploy') {
      if (throwAdmission) throw new Error('ambiguous transport failure');
      return Response.json(admission, { status: http });
    }
    assert.equal(request.action, 'deploy.status');
    assert.deepEqual(request.subject, { application: 'example', environment: 'production', deploymentId: ID });
    const next = replies[Math.min(index++, replies.length - 1)];
    return Response.json(next.body ?? next, { status: next.http ?? 200 });
  };
  let time = 0;
  const options = { now: () => time, sleep: async ms => { time += ms; }, waitMs: 30, pollMs: 10 };
  return { fetcher, calls, options };
}

test('one admission, fresh audience-bound tokens, redirects forbidden, exact terminal identity', async () => {
  const f = fixture({ replies: [status({ phase: 'DEPLOYING_TARGETS', completedTargets: [] }), status()] });
  assert.equal((await main(env, f.fetcher, f.options)).phase, 'SUCCEEDED');
  const posts = f.calls.filter(c => c.init.method === 'POST');
  assert.equal(posts.filter(c => JSON.parse(c.init.body).action === 'deploy').length, 1);
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map(c => c.init.headers.authorization)).size, 3);
  assert.ok(f.calls.filter(c => c.url.hostname === 'oidc.example').every(c => c.url.searchParams.get('audience') === 'services.susanb.dev'));
  assert.ok(f.calls.every(c => ['manual', 'error'].includes(c.init.redirect)));
  assert.deepEqual(JSON.parse(posts[0].init.body), { action: 'deploy', subject: { application: 'example', environment: 'production', releaseTag: 'v1.2.3', intent: 'deploy' } });
});

test('admission alone, including ALREADY_CURRENT, cannot pass', async () => {
  const f = fixture({ admission: { status: 'ALREADY_CURRENT', deploymentId: ID, githubDeploymentId: null }, replies: [status({ phase: 'QUEUED' })] });
  await assert.rejects(main(env, f.fetcher, f.options), /deadline/);
  assert.ok(f.calls.some(c => c.init.body && JSON.parse(c.init.body).action === 'deploy.status'));
});

test('ALREADY_CURRENT succeeds only after exact authenticated terminal readback', async () => {
  const f = fixture({ admission: { status: 'ALREADY_CURRENT', deploymentId: ID, githubDeploymentId: null } });
  assert.equal((await main(env, f.fetcher, f.options)).deploymentId, ID);
});

test('unknown status, changed identity, source, release, digest, target or missing version fail closed', async () => {
  for (const change of [
    { schema: 'other' }, { deploymentId: 'other' }, { application: 'other' }, { environment: 'staging' }, { intent: 'rollback' },
    { sourceCommit: 'c'.repeat(40) }, { requestedReleaseTag: 'v0.0.1' }, { requestedManifestSha256: 'd'.repeat(64) },
    { phase: 'unknown' }, { completedTargets: [] }, { completedTargets: [{ id: 'other', versionId: 'v' }] },
    { completedTargets: [{ id: 'worker', versionId: null }] },
  ]) {
    const f = fixture({ replies: [status(change)] });
    await assert.rejects(main(env, f.fetcher, f.options), /identity|phase|readback/, JSON.stringify(change));
  }
});

test('rollback, failed recovery and rejection fail the originating job', async () => {
  for (const phase of ['ROLLED_BACK', 'RECOVERY_FAILED', 'REJECTED']) {
    const f = fixture({ replies: [status({ phase })] });
    await assert.rejects(main(env, f.fetcher, f.options), new RegExp(phase));
  }
});

test('unauthorized, expired and replayed requests are not retried', async () => {
  for (const error of ['bad_aud', 'bad_iss', 'bad_repo', 'bad_workflow', 'expired', 'replay']) {
    const f = fixture({ http: 403, admission: { error } });
    await assert.rejects(main(env, f.fetcher, f.options), /admission refused/);
    assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
  }
});

test('ambiguous admission transport failure is never retried', async () => {
  const f = fixture({ throwAdmission: true });
  await assert.rejects(main(env, f.fetcher, f.options), /ambiguous/);
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
});

test('malformed admission is rejected before polling', async () => {
  for (const admission of [null, {}, { status: 'SUCCEEDED', deploymentId: ID }, { status: 'QUEUED', deploymentId: 'bad-id' }, { status: 'QUEUED', deploymentId: ID, githubDeploymentId: '7' }]) {
    const f = fixture({ admission });
    await assert.rejects(main(env, f.fetcher, f.options), /admission|GitHub/);
    assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
  }
});

test('only transient read-only HTTP status failures are retried', async () => {
  const f = fixture({ replies: [{ http: 503, body: { error: 'unavailable' } }, status()] });
  assert.equal((await main(env, f.fetcher, f.options)).phase, 'SUCCEEDED');
  const denied = fixture({ replies: [{ http: 403, body: { error: 'bad_repo' } }] });
  await assert.rejects(main(env, denied.fetcher, denied.options), /status refused/);
});

test('invalid event, source, app, environment, tag, digest and targets fail before authentication', () => {
  for (const change of [
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_SHA: 'main' },
    { INPUT_APPLICATION: '../other' }, { INPUT_ENVIRONMENT: 'prod\nevil=x' }, { INPUT_RELEASE_TAG: 'latest' },
    { INPUT_MANIFEST_SHA256: 'bad' }, { INPUT_TARGETS: '[]' }, { INPUT_TARGETS: '["worker","worker"]' }, { INPUT_TARGETS: 'null' },
  ]) assert.throws(() => requestFromEnvironment({ ...env, ...change }));
});

test('target IDs use the existing pipeline contract, including numeric IDs and its 64-character limit', () => {
  const targets = ['1-worker', 'a'.repeat(64)];
  assert.deepEqual(requestFromEnvironment({ ...env, INPUT_TARGETS: JSON.stringify(targets) }).targets, targets);
  assert.throws(() => requestFromEnvironment({ ...env, INPUT_TARGETS: JSON.stringify(['a'.repeat(65)]) }));
});
