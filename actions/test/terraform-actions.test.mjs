import test from 'node:test';
import assert from 'node:assert/strict';
import { main, requestFromEnvironment } from '../request-terraform/main.mjs';

const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const JOB = '0199e7a0-0000-7000-8000-000000000001';
const env = (repo, id, event = 'pull_request') => ({
  GITHUB_REPOSITORY: repo,
  GITHUB_REPOSITORY_ID: String(id),
  GITHUB_EVENT_NAME: event,
  GITHUB_REF: event === 'pull_request' ? 'refs/pull/7/merge' : 'refs/heads/main',
  GITHUB_SHA: SHA,
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fixture-token',
});
const payload = { number: 7, pull_request: { number: 7, base: { ref: 'main', repo: { id: 1417590199 } }, head: { repo: { id: 1417590199 } } } };

function harness(replies) {
  const requests = [];
  const fetcher = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? 'GET', body: init.body });
    if (url.startsWith('https://token.actions.githubusercontent.com/')) {
      return Response.json({ value: 'header.claims.signature' });
    }
    assert.equal(url, 'https://services.susanb.dev/v1/token');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    const parsed = JSON.parse(init.body);
    const next = replies.shift();
    assert(next, 'unexpected extra authorizer request');
    assert.equal(parsed.action, next.action);
    return Response.json(next.body, { status: next.status });
  };
  return { fetcher, requests };
}

test('plans derive repository, stack and exact PR merge ref; applies require main push', () => {
  assert.deepEqual(requestFromEnvironment(env('susanbeasles/infra', 1417590199), payload),
    { action: 'infra.plan', subject: { pullRequest: 7 }, commit: SHA, stack: 'infra', phase: 'plan' });
  const root = env('susanbeasles/infra-root', 1419989558);
  const rootPayload = structuredClone(payload);
  rootPayload.pull_request.base.repo.id = 1419989558;
  rootPayload.pull_request.head.repo.id = 1419989558;
  assert.equal(requestFromEnvironment(root, rootPayload).action, 'root.plan');
  assert.deepEqual(requestFromEnvironment(env('susanbeasles/infra-root', 1419989558, 'push')).subject, {});
  assert.equal(requestFromEnvironment(env('susanbeasles/infra-root', 1419989558, 'push')).action, 'root.apply');
  assert.throws(() => requestFromEnvironment(env('other/infra', 1417590199), payload));
  assert.throws(() => requestFromEnvironment(env('susanbeasles/infra', 12345), payload));
  assert.throws(() => requestFromEnvironment(env('susanbeasles/infra', 1417590199), { ...payload, number: 8 }));
  assert.throws(() => requestFromEnvironment({ ...env('susanbeasles/infra', 1417590199), GITHUB_REF: 'refs/heads/main' }, payload));
});

test('plan admits once, reads terminal status with new OIDC tokens, validates immutable identity', async () => {
  const h = harness([
    { action: 'infra.plan', status: 202, body: { jobId: JOB, state: 'queued' } },
    { action: 'job.status', status: 200, body: { jobId: JOB, type: 'terraform.plan', state: 'running' } },
    { action: 'job.status', status: 200, body: { jobId: JOB, type: 'terraform.plan', state: 'succeeded', result: {
      schema: 'terraform-plan-summary/v1', stack: 'infra', commit: SHA, treeSha: TREE, policyPassed: true, planSha256: DIGEST,
    } } },
  ]);
  const result = await main(env('susanbeasles/infra', 1417590199), h.fetcher,
    { payload, sleep: async () => {}, waitMs: 1000, pollMs: 1 });
  assert.deepEqual(result, { jobId: JOB, stack: 'infra', commit: SHA });
  assert.equal(h.requests.filter(r => r.url === 'https://services.susanb.dev/v1/token').length, 3);
  assert.equal(h.requests.filter(r => r.url.startsWith('https://token.actions.githubusercontent.com/')).length, 3);
});

test('root apply pending owner Access approval is NOT accepted as a completed apply', async () => {
  const h = harness([{ action: 'root.apply', status: 202, body: {
    state: 'awaiting_approval', commit: SHA, approveUrl: 'https://approve.susanb.dev/',
  } }]);
  await assert.rejects(main(env('susanbeasles/infra-root', 1419989558, 'push'), h.fetcher, { payload: null }),
    /pending owner approval/);
  assert.equal(h.requests.filter(r => r.url === 'https://services.susanb.dev/v1/token').length, 1);
});

test('uncertain infrastructure execution is never reported as successful or re-admitted', async () => {
  const h = harness([
    { action: 'infra.apply', status: 202, body: { jobId: JOB, state: 'queued' } },
    { action: 'job.status', status: 200, body: { jobId: JOB, type: 'terraform.apply', state: 'uncertain' } },
  ]);
  await assert.rejects(main(env('susanbeasles/infra', 1417590199, 'push'), h.fetcher, { payload: null }), /uncertain/);
  assert.equal(h.requests.filter(r => r.url === 'https://services.susanb.dev/v1/token').length, 2);
});

test('a forged successful status with mismatched identity is refused', async () => {
  const h = harness([
    { action: 'infra.apply', status: 202, body: { jobId: JOB, state: 'queued' } },
    { action: 'job.status', status: 200, body: { jobId: JOB, type: 'terraform.apply', state: 'succeeded', result: {
      schema: 'terraform-apply-result/v1', stack: 'infra', commit: 'f'.repeat(40), treeSha: TREE, stateSerialAfter: 9,
    } } },
  ]);
  await assert.rejects(main(env('susanbeasles/infra', 1417590199, 'push'), h.fetcher, { payload: null }), /not bound/);
});
