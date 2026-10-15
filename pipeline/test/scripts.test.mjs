// Tests for pipeline/scripts/*.cjs and pipeline/embed.mjs. No dependencies; git and tar from the system.
//   node --test pipeline/test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { embed } from '../embed.mjs';

const require = createRequire(import.meta.url);
const route = require('../scripts/workflow-sha.cjs');
const commitlint = require('../scripts/commitlint.cjs');
const lockfile = require('../scripts/lockfile-check.cjs');
const pkg = require('../scripts/package.cjs');
const coverage = require('../scripts/coverage-check.cjs');

const SHA_A = 'a'.repeat(40);
const scratch = () => mkdtempSync(path.join(tmpdir(), 'pipeline-test-'));
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
const GOOD = { job_workflow_ref: 'susanbeasles/workflow_depot/.github/workflows/pipeline.yml@refs/heads/main', job_workflow_sha: SHA_A };

// ---- workflow-sha.cjs ---------------------------------------------------------------------------

function tokenServer(body, status = 200, seen = []) {
  return async (url, init) => {
    seen.push({ url: String(url), init });
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

test('workflow-sha: writes the job_workflow_sha claim and asks for a routing-only audience', async () => {
  const dir = scratch();
  const out = path.join(dir, 'out');
  writeFileSync(out, '');
  const seen = [];
  const logs = [];
  const sha = await route.main({ ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/x?api-version=2.0', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'bearer-value', GITHUB_OUTPUT: out }, tokenServer({ value: jwt(GOOD) }, 200, seen), (l) => logs.push(l));
  assert.equal(sha, SHA_A);
  assert.equal(readFileSync(out, 'utf8'), `sha=${SHA_A}\n`);
  const url = new URL(seen[0].url);
  assert.equal(url.searchParams.get('audience'), 'workflow-depot-route');
  assert.equal(url.searchParams.get('api-version'), '2.0');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.authorization, 'bearer bearer-value');
  assert.ok(!logs.join('\n').includes(jwt(GOOD)), 'the token is never logged');
  assert.ok(!logs.join('\n').includes('bearer-value'));
  rmSync(dir, { recursive: true });
});

test('workflow-sha: accepts any ref of pipeline.yml in workflow_depot (the authorizer pins it)', () => {
  for (const ref of ['refs/heads/main', SHA_A, 'refs/tags/v1']) {
    assert.equal(route.workflowSha({ ...GOOD, job_workflow_ref: `${route.WORKFLOW}${ref}` }), SHA_A);
  }
});

test('workflow-sha: refuses a token from any other workflow or repository', () => {
  for (const ref of [
    'susanbeasles/workflow_depot/.github/workflows/other.yml@refs/heads/main',
    'evil/workflow_depot/.github/workflows/pipeline.yml@refs/heads/main',
    'susanbeasles/workflow_depot_fork/.github/workflows/pipeline.yml@refs/heads/main',
    'susanbeasles/workflow_depot/.github/workflows/pipeline.yml@',
    'susanbeasles/workflow_depot/.github/workflows/pipeline.yml',
    undefined,
    42,
  ]) {
    assert.throws(() => route.workflowSha({ ...GOOD, job_workflow_ref: ref }), route.RouteError, String(ref));
  }
});

test('workflow-sha: refuses a missing or malformed job_workflow_sha', () => {
  for (const sha of [undefined, '', 'A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), `${'a'.repeat(39)}\n`, 'main', 7]) {
    assert.throws(() => route.workflowSha({ ...GOOD, job_workflow_sha: sha }), route.RouteError, String(sha));
  }
});

test('workflow-sha: refuses tokens that are not JWTs with an object payload', () => {
  for (const token of ['', 'a.b', 'a.b.c.d', `x.${Buffer.from('not json').toString('base64url')}.y`, `x.${b64([1])}.y`, `x.${b64(null)}.y`, 'x.a+b.y', null]) {
    assert.throws(() => route.decodeClaims(token), route.RouteError, String(token));
  }
});

test('workflow-sha: fails clearly without id-token permission or on a bad token response', async () => {
  await assert.rejects(route.main({}, tokenServer({})), /id-token: write/);
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't' };
  await assert.rejects(route.main(env, tokenServer({}, 403)), /failed with 403/);
  await assert.rejects(route.main(env, tokenServer('<html>')), /not JSON/);
  await assert.rejects(route.main(env, tokenServer({ nope: 1 })), /has no token/);
  await assert.rejects(route.main(env, tokenServer('x'.repeat(20000))), /too large/);
  await assert.rejects(route.main(env, tokenServer({ value: jwt({ ...GOOD, job_workflow_ref: 'evil/x/.github/workflows/pipeline.yml@main' }) })), /job_workflow_ref/);
});

// ---- commitlint.cjs -----------------------------------------------------------------------------

test('commitlint: accepts conventional headers', () => {
  for (const message of [
    'feat: add thing',
    'fix(api): reject empty body',
    'feat(scope/sub-1.x)!: drop node 18',
    'chore!: bump',
    'docs: explain\n\nLonger body.\n\nRefs: #1',
    'revert: feat: add thing',
  ]) assert.deepEqual(commitlint.lintMessage(message), [], message);
});

test('commitlint: rejects non-conventional headers', () => {
  for (const message of [
    'Add thing',
    'feat:add thing',
    'feat: ',
    'Feat: add thing',
    'feature: add thing',
    'feat(): add thing',
    'feat(Scope): add thing',
    `feat: ${'x'.repeat(100)}`,
    'feat: add thing\nno blank line',
    'fixup! feat: add thing',
    'Revert "feat: add thing"',
    '',
  ]) assert.ok(commitlint.lintMessage(message).length > 0, JSON.stringify(message));
});

test('commitlint: squashed commits may use autosquash and revert subjects', () => {
  for (const message of ['fixup! feat: add thing', 'squash! fix: x', 'amend! fix: x', 'Revert "feat: add thing"']) {
    assert.deepEqual(commitlint.lintMessage(message, { squashed: true }), [], message);
  }
  assert.ok(commitlint.lintMessage('wip', { squashed: true }).length > 0);
});

test('commitlint: escapes workflow command data', () => {
  assert.equal(commitlint.escapeData('a%b\r\n::set-env name=x::y'), 'a%25b%0D%0A::set-env name=x::y');
});

function gitRepo() {
  const dir = scratch();
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (message) => { git('commit', '-q', '--allow-empty', '-m', message); return git('rev-parse', 'HEAD'); };
  return { dir, git, commit, run: (args) => git(...args) + '\n' };
}

test('commitlint: pull_request range lints every non-merge commit; push lints only the head', () => {
  const r = gitRepo();
  const base = r.commit('chore: base');
  r.git('checkout', '-q', '-b', 'topic');
  r.commit('feat: good');
  const fixup = r.commit('fixup! feat: good');
  const bad = r.commit('bad message\nwith a body');
  const lines = [];
  const lintPr = (head) => commitlint.main({ EVENT_NAME: 'pull_request', BASE_SHA: base, HEAD_SHA: head }, (args) => r.git(...args), (l) => lines.push(l));
  assert.equal(lintPr(bad), false);
  assert.equal(lines.filter((l) => l.startsWith('::error')).length, 1);
  assert.match(lines.find((l) => l.startsWith('::error')), new RegExp(`^::error title=commit message ${bad.slice(0, 12)}::`));
  assert.ok(!lines.some((l) => /with a body/.test(l)), 'only the header is echoed');
  assert.match(lines.join('\n'), /3 commit\(s\) checked, 1 failing/);
  // A merge commit from "update branch" is skipped on pull_request.
  r.git('checkout', '-q', 'main');
  r.commit('chore: main moved');
  r.git('checkout', '-q', '-b', 'topic2', fixup);
  r.git('merge', '-q', '--no-ff', '-m', "Merge branch 'main' into topic", 'main');
  lines.length = 0;
  assert.equal(lintPr(r.git('rev-parse', 'HEAD')), true, lines.join('\n'));
  // push: the candidate's own message is strict, fixup is not accepted.
  lines.length = 0;
  const push = (head) => commitlint.main({ EVENT_NAME: 'push', HEAD_SHA: head }, (args) => r.git(...args), (l) => lines.push(l));
  assert.equal(push(r.commit('feat(x): candidate (#12)')), true);
  assert.equal(push(r.commit('fixup! feat: good')), false);
  assert.match(lines.join('\n'), /retitle the PR/);
  rmSync(r.dir, { recursive: true });
});

test('commitlint: refuses malformed SHAs and other events before running git', () => {
  const never = () => { throw new Error('git must not run'); };
  assert.throws(() => commitlint.main({ EVENT_NAME: 'pull_request', BASE_SHA: SHA_A, HEAD_SHA: '--output=/tmp/x' }, never), /HEAD_SHA/);
  assert.throws(() => commitlint.main({ EVENT_NAME: 'pull_request', BASE_SHA: 'HEAD~5', HEAD_SHA: SHA_A }, never), /BASE_SHA/);
  assert.throws(() => commitlint.main({ EVENT_NAME: 'workflow_dispatch', HEAD_SHA: SHA_A }, never), /not workflow_dispatch/);
});

// ---- lockfile-check.cjs -------------------------------------------------------------------------

function npmProject(manifest, lock) {
  const dir = scratch();
  if (manifest !== undefined) writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  if (lock !== undefined) writeFileSync(path.join(dir, 'package-lock.json'), typeof lock === 'string' ? lock : JSON.stringify(lock));
  return dir;
}
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const goodLock = (extra = {}) => ({
  name: 'x', lockfileVersion: 3, requires: true,
  packages: {
    '': { name: 'x', dependencies: { a: '^1.0.0' }, devDependencies: { b: '2.0.0' } },
    'node_modules/a': { version: '1.2.0', resolved: 'https://registry.npmjs.org/a/-/a-1.2.0.tgz', integrity: INTEGRITY },
    'node_modules/b': { version: '2.0.0', resolved: 'https://registry.npmjs.org/b/-/b-2.0.0.tgz', integrity: INTEGRITY, dev: true },
    'node_modules/local': { resolved: 'packages/local', link: true },
    ...extra,
  },
});
const manifest = { name: 'x', dependencies: { a: '^1.0.0' }, devDependencies: { b: '2.0.0' } };

test('lockfile-check: a consistent, integrity-pinned lockfile passes', () => {
  const dir = npmProject(manifest, goodLock());
  const r = lockfile.check(dir);
  assert.deepEqual(r.errors, []);
  assert.equal(r.packages, 2);
  assert.equal(lockfile.main(dir, () => {}), true);
  rmSync(dir, { recursive: true });
});

test('lockfile-check: no package.json is not an npm project and passes', () => {
  const dir = npmProject();
  assert.equal(lockfile.check(dir).skipped, true);
  assert.equal(lockfile.main(dir, () => {}), true);
  rmSync(dir, { recursive: true });
});

test('lockfile-check: refuses a missing, unparseable or v1 lockfile', () => {
  for (const [lock, pattern] of [[undefined, /no package-lock\.json/], ['{', /cannot parse/], [{ lockfileVersion: 1, dependencies: {} }, /lockfileVersion 1/]]) {
    const dir = npmProject(manifest, lock);
    const r = lockfile.check(dir);
    assert.match(r.errors.join('\n'), pattern);
    assert.equal(lockfile.main(dir, () => {}), false);
    rmSync(dir, { recursive: true });
  }
});

test('lockfile-check: refuses drift between package.json and the lockfile', () => {
  for (const changed of [
    { ...manifest, dependencies: { a: '^1.1.0' } },
    { ...manifest, dependencies: { a: '^1.0.0', c: '1.0.0' } },
    { ...manifest, devDependencies: {} },
    { ...manifest, optionalDependencies: { d: '1.0.0' } },
  ]) {
    const dir = npmProject(changed, goodLock());
    assert.match(lockfile.check(dir).errors.join('\n'), /out of date with package\.json/, JSON.stringify(changed));
    rmSync(dir, { recursive: true });
  }
});

test('lockfile-check: refuses packages without integrity or from non-https sources', () => {
  for (const [entry, pattern] of [
    [{ version: '1.0.0', resolved: 'https://registry.npmjs.org/c/-/c-1.0.0.tgz' }, /no integrity/],
    [{ version: '1.0.0', resolved: 'http://registry.npmjs.org/c/-/c-1.0.0.tgz', integrity: INTEGRITY }, /only https/],
    [{ version: '1.0.0', resolved: 'git+ssh://git@github.com/x/c.git#abc' }, /only https/],
    [{ version: '1.0.0', resolved: 'file:../c.tgz' }, /only https/],
  ]) {
    const dir = npmProject(manifest, goodLock({ 'node_modules/c': entry }));
    assert.match(lockfile.check(dir).errors.join('\n'), pattern, JSON.stringify(entry));
    rmSync(dir, { recursive: true });
  }
});

test('lockfile-check: sha1-only integrity is a warning; PR text in messages is escaped', () => {
  const dir = npmProject(manifest, goodLock({ 'node_modules/old': { version: '0.1.0', resolved: 'https://registry.npmjs.org/old/-/old-0.1.0.tgz', integrity: 'sha1-abc=' }, 'node_modules/x\n::warning::injected': { resolved: 'http://x' } }));
  const r = lockfile.check(dir);
  assert.equal(r.warnings.length, 1);
  const lines = [];
  lockfile.main(dir, (l) => lines.push(l));
  assert.ok(lines.every((l) => !l.includes('\n')), 'every log line is one line');
  assert.ok(lines.some((l) => l.includes('%0A::warning::injected')));
  rmSync(dir, { recursive: true });
});

// ---- package.cjs --------------------------------------------------------------------------------

const sha256 = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

function tree(root, mtime) {
  mkdirSync(path.join(root, 'dist', 'b'), { recursive: true });
  writeFileSync(path.join(root, 'dist', 'z.js'), 'z');
  writeFileSync(path.join(root, 'dist', 'a.js'), 'a');
  writeFileSync(path.join(root, 'dist', 'b', 'c.txt'), 'c');
  for (const f of ['dist/z.js', 'dist/a.js', 'dist/b/c.txt', 'dist/b', 'dist']) utimesSync(path.join(root, f), mtime, mtime);
}

test('package: a directory becomes a deterministic tar.gz with sorted names and fixed metadata', () => {
  const one = scratch();
  const two = scratch();
  tree(one, 1_000_000);
  tree(two, 2_000_000);
  chmodSync(path.join(two, 'dist', 'a.js'), 0o666);
  const a = pkg.packageArtifact({ artifactPath: 'dist', cwd: one, outDir: path.join(one, 'out') });
  const b = pkg.packageArtifact({ artifactPath: 'dist/', cwd: two, outDir: path.join(two, 'out') });
  assert.equal(a.artifact_name, 'dist.tar.gz');
  assert.match(a.artifact_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(a.artifact_digest, b.artifact_digest, 'same content, different mtimes and modes, same digest');
  assert.equal(a.artifact_digest, sha256(readFileSync(a.artifact_file)));
  const listing = execFileSync('tar', ['-tvf', '-'], { input: gunzipSync(readFileSync(a.artifact_file)), encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  const names = listing.trim().split('\n').map((l) => l.split(/\s+/).pop());
  assert.deepEqual(names, ['dist/', 'dist/a.js', 'dist/b/', 'dist/b/c.txt', 'dist/z.js']);
  assert.ok(listing.split('\n').filter(Boolean).every((l) => /^(-rw-r--r--|drwxr-xr-x) 0\/0 /.test(l) && /1970-01-01/.test(l)), listing);
  writeFileSync(path.join(two, 'dist', 'a.js'), 'changed');
  assert.notEqual(pkg.packageArtifact({ artifactPath: 'dist', cwd: two, outDir: path.join(two, 'out2') }).artifact_digest, a.artifact_digest);
  rmSync(one, { recursive: true });
  rmSync(two, { recursive: true });
});

test('package: a file is used as is and its digest written to GITHUB_OUTPUT', () => {
  const dir = scratch();
  writeFileSync(path.join(dir, 'app.bin'), 'binary');
  const out = path.join(dir, 'gh-out');
  writeFileSync(out, '');
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const r = pkg.main({ ARTIFACT_PATH: 'app.bin', OUT_DIR: path.join(dir, 'out'), GITHUB_WORKSPACE: dir, GITHUB_OUTPUT: out }, () => {});
    assert.equal(r.artifact_digest, sha256(Buffer.from('binary')));
    assert.equal(readFileSync(out, 'utf8'), `artifact_file=${r.artifact_file}\nartifact_name=app.bin\nartifact_digest=${r.artifact_digest}\n`);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true });
  }
});

test('package: empty artifact-path runs npm pack --ignore-scripts and uses its output', () => {
  const dir = scratch();
  writeFileSync(path.join(dir, 'package.json'), '{}');
  const calls = [];
  const fakeRun = (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd });
    writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], 'scope-name-1.0.0.tgz'), 'tgz');
    return JSON.stringify([{ filename: 'scope-name-1.0.0.tgz' }]);
  };
  const r = pkg.packageArtifact({ cwd: dir, outDir: path.join(dir, 'out') }, fakeRun);
  assert.deepEqual(calls[0].args.slice(0, 3), ['pack', '--ignore-scripts', '--json']);
  assert.equal(calls[0].cmd, 'npm');
  assert.equal(r.artifact_name, 'scope-name-1.0.0.tgz');
  assert.equal(r.artifact_digest, sha256(Buffer.from('tgz')));
  assert.throws(() => pkg.packageArtifact({ cwd: dir, outDir: path.join(dir, 'o2') }, () => JSON.stringify([{ filename: '../escape.tgz' }])), pkg.PackageError);
  assert.throws(() => pkg.packageArtifact({ cwd: dir, outDir: path.join(dir, 'o3') }, () => 'npm WARN'), /no JSON/);
  rmSync(dir, { recursive: true });
});

test('package: refuses no package.json, missing paths, paths outside the workspace and odd names', () => {
  const ws = scratch();
  const outside = scratch();
  writeFileSync(path.join(outside, 'secret.txt'), 's');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'link.txt'));
  writeFileSync(path.join(ws, 'bad name.txt'), 'x');
  const opts = { cwd: ws, workspace: ws, outDir: path.join(ws, 'out') };
  assert.throws(() => pkg.packageArtifact(opts), /no package\.json/);
  assert.throws(() => pkg.packageArtifact({ ...opts, artifactPath: 'nope' }), /does not exist/);
  assert.throws(() => pkg.packageArtifact({ ...opts, artifactPath: path.join(outside, 'secret.txt') }), /outside the workspace/);
  assert.throws(() => pkg.packageArtifact({ ...opts, artifactPath: 'link.txt' }), /outside the workspace/);
  assert.throws(() => pkg.packageArtifact({ ...opts, artifactPath: 'bad name.txt' }), /must match/);
  assert.throws(() => pkg.packageArtifact({ ...opts, outDir: undefined, artifactPath: 'bad name.txt' }), /no output directory/);
  rmSync(ws, { recursive: true });
  rmSync(outside, { recursive: true });
});

// ---- coverage-check.cjs -------------------------------------------------------------------------

function summaryDir(total) {
  const dir = scratch();
  mkdirSync(path.join(dir, 'coverage'));
  if (total !== undefined) writeFileSync(path.join(dir, 'coverage', 'coverage-summary.json'), JSON.stringify({ total }));
  return dir;
}
const LINES = (pct, covered = 80, total = 100) => ({ lines: { total, covered, skipped: 0, pct } });

test('coverage-check: passes at or above the threshold, fails below it, and reports both', () => {
  const env = (min) => ({ COVERAGE_SUMMARY: 'coverage/coverage-summary.json', COVERAGE_MIN: min });
  const ok = summaryDir(LINES(80));
  assert.equal(coverage.check(ok, 'coverage/coverage-summary.json', '80').ok, true);
  const logs = [];
  assert.equal(coverage.main(env('80'), ok, (l) => logs.push(l)).ok, true);
  assert.match(logs[0], /^coverage: line coverage 80% \(80\/100\); threshold 80%$/);
  const low = summaryDir(LINES(79.99, 7999, 10000));
  const fail = [];
  assert.equal(coverage.main(env('80'), low, (l) => fail.push(l)).ok, false);
  assert.match(fail[0], /^::error title=coverage::line coverage 79\.99%/);
  assert.equal(coverage.check(low, 'coverage/coverage-summary.json', '90').ok, false);
});

test('coverage-check: refuses missing, empty, malformed, symlinked and climbing summaries and bad thresholds', () => {
  const missing = summaryDir();
  assert.throws(() => coverage.check(missing, 'coverage/coverage-summary.json', '80'), /does not exist/);
  for (const total of [{}, { lines: { total: 0, covered: 0, pct: 'Unknown' } }, { lines: { total: 10, covered: 5, pct: 'x' } }, null]) {
    assert.throws(() => coverage.check(summaryDir(total), 'coverage/coverage-summary.json', '80'), /total\.lines/, JSON.stringify(total));
  }
  const bad = summaryDir();
  writeFileSync(path.join(bad, 'coverage', 'coverage-summary.json'), '{not json');
  assert.throws(() => coverage.check(bad, 'coverage/coverage-summary.json', '80'), /not JSON/);
  const linked = summaryDir(LINES(100, 100, 100));
  symlinkSync(path.join(linked, 'coverage', 'coverage-summary.json'), path.join(linked, 'coverage', 'link.json'));
  assert.throws(() => coverage.check(linked, 'coverage/link.json', '80'), /regular file/);
  for (const rel of ['../coverage-summary.json', '/etc/passwd', './coverage/coverage-summary.json', '']) {
    assert.throws(() => coverage.check(linked, rel, '80'), /normalized relative path/, rel);
  }
  for (const min of ['0', '101', '80.5', '', 'eighty', undefined]) {
    assert.throws(() => coverage.check(linked, 'coverage/coverage-summary.json', min), /COVERAGE_MIN/, String(min));
  }
});

// ---- embed.mjs ----------------------------------------------------------------------------------

test('embed: replaces the marked run block with the script, indented, and is idempotent', () => {
  const yaml = ['jobs:', '  a:', '    steps:', '      - shell: node {0}', '        # embedded: pipeline/scripts/x.cjs', '        run: |', '          old', '', '          old2', '      - run: echo next', ''].join('\n');
  const script = "'use strict';\n\nconsole.log(1);\n";
  const once = embed(yaml, () => script);
  assert.equal(once, ['jobs:', '  a:', '    steps:', '      - shell: node {0}', '        # embedded: pipeline/scripts/x.cjs', '        run: |', "          'use strict';", '', '          console.log(1);', '      - run: echo next', ''].join('\n'));
  assert.equal(embed(once, () => script), once);
});

test('embed: refuses scripts Actions would expand or that YAML would change', () => {
  const yaml = '      # embedded: pipeline/scripts/x.cjs\n      run: |\n        old\n';
  assert.throws(() => embed(yaml, () => 'a = `${{ x }}`;\n'), /Actions would expand/);
  assert.throws(() => embed(yaml, () => 'no newline'), /exactly one newline/);
  assert.throws(() => embed(yaml, () => 'two\n\n'), /exactly one newline/);
  assert.throws(() => embed('      # embedded: pipeline/scripts/x.cjs\n      run: >\n', () => 'x\n'), /expected/);
});
