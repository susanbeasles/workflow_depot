'use strict';
// pipeline/scripts/commitlint.cjs: Conventional Commits check for the commits a run would land.
// Embedded byte for byte in pipeline.yml (shell: node {0}); pipeline/test checks that the two match.
// pull_request: every commit in BASE_SHA..HEAD_SHA. The promoter squashes them, so merge commits are
// skipped and git's autosquash and revert subjects are accepted. push (shadow candidate): HEAD_SHA only,
// strictly; that commit's message is what lands on main. No dependencies.
const { execFileSync } = require('node:child_process');

const TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
const HEADER = /^([a-z]+)(\([a-z0-9][a-z0-9._/-]*\))?(!)?: (\S.*)$/;
const MAX_HEADER = 100;
const SQUASHED = /^(fixup|squash|amend)! |^Revert "/;
const SHA = /^[0-9a-f]{40}$/;

/** Problems with one commit message ([] when it conforms). `squashed` relaxes rules for commits the promoter squashes. */
function lintMessage(message, { squashed = false } = {}) {
  const lines = String(message).replace(/\r\n/g, '\n').split('\n');
  const header = lines[0];
  if (squashed && SQUASHED.test(header)) return [];
  const problems = [];
  const match = HEADER.exec(header);
  if (match === null) {
    problems.push('header must be `type(scope)!: description`, e.g. `fix(api): reject empty body`');
  } else if (!TYPES.includes(match[1])) {
    problems.push(`type \`${match[1]}\` is not one of ${TYPES.join(', ')}`);
  }
  if (header.length > MAX_HEADER) problems.push(`header is ${header.length} characters; the limit is ${MAX_HEADER}`);
  if (lines.length > 1 && lines[1].trim() !== '') problems.push('leave a blank line between the header and the body');
  return problems;
}

/** Escape a value for a workflow command so commit text cannot inject commands or annotations. */
function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function readCommits(args, git) {
  const out = git(['log', '--no-color', '--format=%H%x1f%P%x1f%B%x1e', ...args]);
  return out.split('\x1e').map((entry) => entry.replace(/^\n/, '')).filter((entry) => entry !== '').map((entry) => {
    const [sha, parents, body] = entry.split('\x1f');
    return { sha, parents: parents.trim() === '' ? [] : parents.trim().split(' '), message: body.replace(/\n+$/, '') };
  });
}

function defaultGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main(env = process.env, git = defaultGit, log = console.log) {
  const event = env.EVENT_NAME;
  const head = env.HEAD_SHA ?? '';
  if (!SHA.test(head)) throw new Error('HEAD_SHA must be 40 lowercase hex');
  let commits;
  let squashed;
  if (event === 'pull_request') {
    const base = env.BASE_SHA ?? '';
    if (!SHA.test(base)) throw new Error('BASE_SHA must be 40 lowercase hex on pull_request');
    commits = readCommits([`${base}..${head}`], git);
    squashed = true;
  } else if (event === 'push') {
    commits = readCommits(['-1', head], git);
    squashed = false;
  } else {
    throw new Error(`commitlint runs on pull_request or push, not ${event}`);
  }
  let failed = 0;
  let checked = 0;
  for (const commit of commits) {
    if (squashed && commit.parents.length > 1) continue;
    checked += 1;
    const problems = lintMessage(commit.message, { squashed });
    if (problems.length === 0) continue;
    failed += 1;
    const header = commit.message.split('\n')[0];
    log(`::error title=commit message ${commit.sha.slice(0, 12)}::${escapeData(`${problems.join('; ')} (header: ${header})`)}`);
  }
  log(`commitlint: ${checked} commit(s) checked, ${failed} failing`);
  if (failed > 0) {
    log(event === 'push'
      ? 'The candidate commit message comes from the pull request title: retitle the PR as `type(scope): description`.'
      : 'Reword with `git rebase -i` (reword) or a `fixup!` commit, then push.');
  }
  return failed === 0;
}

module.exports = { TYPES, MAX_HEADER, lintMessage, escapeData, readCommits, main };

if (require.main === module) {
  try {
    if (!main()) process.exitCode = 1;
  } catch (error) {
    console.log(`::error title=commitlint::${escapeData(error.message)}`);
    process.exitCode = 1;
  }
}
