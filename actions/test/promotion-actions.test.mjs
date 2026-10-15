import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as shadow } from '../request-shadow/main.mjs';
import { run as promotion } from '../request-promotion/main.mjs';

const HEAD = 'a'.repeat(40);
const CAND = 'b'.repeat(40);
const NEW = 'c'.repeat(40);
const JWT = 'header.payload.signature';

function env(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wd-actions-'));
  const files = { out: join(dir, 'out'), sum: join(dir, 'sum'), event: join(dir, 'event.json') };
  writeFileSync(files.out, '');
  writeFileSync(files.sum, '');
  writeFileSync(files.event, JSON.stringify({ pull_request: { number: 7, head: { sha: HEAD }, base: { ref: 'main' } } }));
  return {
    files,
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/oidc?x=1',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-request-token',
      GITHUB_REPOSITORY: 'susanbeasles/deployer',
      GITHUB_REPOSITORY_ID: '1405415291',
      GITHUB_OUTPUT: files.out,
      GITHUB_STEP_SUMMARY: files.sum,
      GITHUB_EVENT_PATH: files.event,
      ...extra,
    },
  };
}

function fakeFetch(answer) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith('https://token.example/')) return new Response(JSON.stringify({ value: JWT }), { status: 200 });
    const { status, body } = answer(JSON.parse(init.body));
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: status >= 300 && status < 400 ? { location: 'https://vespoli.cloudflareaccess.com/login' } : {} });
  };
  return { impl, calls };
}

const quiet = () => undefined;

test('request-shadow sends shadow.prepare with the PR head and the OIDC token for the authorizer audience', async () => {
  const { env: e, files } = env({ GITHUB_EVENT_NAME: 'pull_request' });
  const f = fakeFetch(() => ({ status: 200, body: { ok: true, action: 'shadow.prepare', candidate_sha: CAND, base_sha: 'd'.repeat(40), shadow_ref: 'refs/heads/shadow/pr-7', reused: false } }));
  await shadow(e, f.impl, quiet);
  assert.equal(new URL(f.calls[0].url).searchParams.get('audience'), 'services.susanb.dev');
  assert.equal(f.calls[0].url.includes('x=1'), true);
  assert.equal(f.calls[1].url, 'https://services.susanb.dev/v1/token');
  assert.equal(f.calls[1].init.redirect, 'manual');
  assert.equal(f.calls[1].init.headers.authorization, `Bearer ${JWT}`);
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { action: 'shadow.prepare', subject: { repo: 'susanbeasles/deployer', repo_id: 1405415291, pr: 7, head_sha: HEAD } });
  assert.match(readFileSync(files.out, 'utf8'), new RegExp(`candidate_sha=${CAND}\nshadow_ref=refs/heads/shadow/pr-7\nreused=false\n`));
  assert.match(readFileSync(files.sum, 'utf8'), /Shadow candidate/);
});

test('request-promotion promotes the exact pushed candidate and reports the tag', async () => {
  const { env: e, files } = env({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/shadow/pr-7', GITHUB_SHA: CAND, INPUT_ARTIFACT_DIGEST: `sha256:${'e'.repeat(64)}` });
  const f = fakeFetch(() => ({ status: 200, body: { ok: true, action: 'promote', main_sha: CAND, tag: 'promote/pr-7-bbbbbbbbbbbb', already_promoted: false, pending: [] } }));
  await promotion(e, f.impl, quiet);
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { action: 'promote', subject: { repo: 'susanbeasles/deployer', repo_id: 1405415291, pr: 7, candidate_sha: CAND, artifact_digest: `sha256:${'e'.repeat(64)}` } });
  assert.match(readFileSync(files.out, 'utf8'), /outcome=promoted\nmain_sha=b{40}\ntag=promote\/pr-7-b{12}\n/);
});

test('stale_base ends the run as superseded, not failed, and names the new candidate', async () => {
  const { env: e, files } = env({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/shadow/pr-7', GITHUB_SHA: CAND });
  const lines = [];
  const f = fakeFetch(() => ({ status: 403, body: { ok: false, status: 403, code: 'stale_base', candidate_sha: NEW } }));
  await promotion(e, f.impl, (l) => lines.push(l));
  assert.match(readFileSync(files.out, 'utf8'), new RegExp(`outcome=stale_base\ncandidate_sha=${NEW}\n`));
  assert.match(lines.join('\n'), /::warning/);
});

test('refusals, redirects and wrong events fail with the stable code and never print the token', async () => {
  const cases = [
    [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/shadow/pr-7', GITHUB_SHA: CAND }, () => ({ status: 403, body: { ok: false, code: 'checks_not_green', detail: 'pipeline / security' } }), /checks_not_green: pipeline \/ security/],
    [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/shadow/pr-7', GITHUB_SHA: CAND }, () => ({ status: 302 }), /redirect means an Access application is misconfigured/],
    [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/shadow/pr-7', GITHUB_SHA: CAND }, () => ({ status: 200, body: { ok: true, main_sha: NEW } }), /promote refused/],
    [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: CAND }, null, /not a shadow branch/],
    [{ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/heads/shadow/pr-7', GITHUB_SHA: CAND }, null, /only on push/],
    [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/shadow/pr-7', GITHUB_SHA: CAND, INPUT_ARTIFACT_DIGEST: 'md5:abc' }, null, /artifact-digest/],
    [{ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/shadow/pr-7', GITHUB_SHA: CAND, ACTIONS_ID_TOKEN_REQUEST_URL: '' }, null, /id-token: write/],
  ];
  for (const [extra, answer, pattern] of cases) {
    const { env: e } = env(extra);
    const f = fakeFetch(answer ?? (() => ({ status: 500 })));
    await assert.rejects(promotion(e, f.impl, quiet), (err) => pattern.test(err.message) && !err.message.includes(JWT) && !err.message.includes('runtime-request-token'));
  }
  const { env: e } = env({ GITHUB_EVENT_NAME: 'pull_request' });
  writeFileSync(e.GITHUB_EVENT_PATH, JSON.stringify({ pull_request: { number: 7, head: { sha: HEAD }, base: { ref: 'develop' } } }));
  await assert.rejects(shadow(e, fakeFetch(() => ({ status: 200 })).impl, quiet), /not main/);
  const { env: e2 } = env({ GITHUB_EVENT_NAME: 'pull_request' });
  await assert.rejects(shadow(e2, fakeFetch(() => ({ status: 403, body: { code: 'conflict' } })).impl, quiet), /shadow.prepare refused \(403\): conflict/);
});

test('outputs refuse newlines so a hostile response cannot inject extra outputs', async () => {
  const { env: e } = env({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/shadow/pr-7', GITHUB_SHA: CAND });
  const f = fakeFetch(() => ({ status: 200, body: { ok: true, main_sha: CAND, tag: 'x\nmain_sha=evil' } }));
  await assert.rejects(promotion(e, f.impl, quiet), /contains a newline/);
});
