'use strict';
// pipeline/scripts/coverage-check.cjs: stage 1 coverage gate. Embedded byte for byte in pipeline.yml
// (shell: node {0}); pipeline/test checks that the two match. Runs in the caller's working directory after the
// test script. COVERAGE_SUMMARY is the Istanbul json-summary path from pipeline.json and COVERAGE_MIN the line
// threshold of the policy profile, both validated by ci/pipeline-config.mjs in the config job and checked again
// here. Fails unless total.lines covered/total reaches the threshold over a non-empty line count. The report path
// may not pass through a symlink at any component, and its reported numbers must be self-consistent: a malformed
// summary cannot pass the gate.
const { appendFileSync, lstatSync, readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 8 * 1024 * 1024;
const RELATIVE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

class CoverageError extends Error {}

function check(cwd, summaryPath, min) {
  if (typeof summaryPath !== 'string' || !RELATIVE.test(summaryPath) || summaryPath.split('/').some((s) => s === '.' || s === '..')) {
    throw new CoverageError('COVERAGE_SUMMARY must be a normalized relative path');
  }
  const threshold = Number(min);
  if (!/^[1-9][0-9]?$|^100$/.test(String(min)) || !Number.isInteger(threshold)) throw new CoverageError('COVERAGE_MIN must be an integer from 1 to 100');
  const segments = summaryPath.split('/');
  let file = cwd;
  let stat;
  for (const [i, segment] of segments.entries()) {
    file = path.join(file, segment);
    try {
      stat = lstatSync(file);
    } catch {
      throw new CoverageError(`${summaryPath} does not exist: the test script must write an Istanbul json-summary report there`);
    }
    if (stat.isSymbolicLink()) throw new CoverageError(`${summaryPath}: ${segments.slice(0, i + 1).join('/')} is a symlink; the report must be a regular file inside the working directory`);
    if (i < segments.length - 1 && !stat.isDirectory()) throw new CoverageError(`${summaryPath}: ${segments.slice(0, i + 1).join('/')} is not a directory`);
  }
  if (!stat.isFile()) throw new CoverageError(`${summaryPath} must be a regular file, not a symlink or directory`);
  const realCwd = realpathSync(cwd);
  if (!realpathSync(file).startsWith(`${realCwd}${path.sep}`)) throw new CoverageError(`${summaryPath} resolves outside the working directory`);
  if (stat.size > MAX_BYTES) throw new CoverageError(`${summaryPath} is larger than ${MAX_BYTES} bytes`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new CoverageError(`${summaryPath} is not JSON`);
  }
  const lines = data !== null && typeof data === 'object' ? data.total?.lines : undefined;
  if (lines === null || typeof lines !== 'object' || !Number.isInteger(lines.total) || lines.total <= 0 || typeof lines.pct !== 'number' || !Number.isFinite(lines.pct)) {
    throw new CoverageError(`${summaryPath} has no total.lines with a positive line count`);
  }
  if (!Number.isInteger(lines.covered) || lines.covered < 0 || lines.covered > lines.total) {
    throw new CoverageError(`${summaryPath}: total.lines.covered must be an integer from 0 to total.lines.total`);
  }
  if (lines.pct < 0 || lines.pct > 100) throw new CoverageError(`${summaryPath}: total.lines.pct must be from 0 to 100`);
  // The decision uses the counts, never the reported percentage; a pct that disagrees with them is malformed.
  const pct = (lines.covered * 100) / lines.total;
  if (Math.abs(pct - lines.pct) > 0.01 + Number.EPSILON * 100) throw new CoverageError(`${summaryPath}: total.lines.pct ${lines.pct} disagrees with covered/total ${lines.covered}/${lines.total}`);
  return { pct: Math.floor((lines.covered * 10000) / lines.total) / 100, covered: lines.covered, total: lines.total, threshold, ok: lines.covered * 100 >= threshold * lines.total };
}

function main(env = process.env, cwd = process.cwd(), log = console.log) {
  const result = check(cwd, env.COVERAGE_SUMMARY, env.COVERAGE_MIN);
  const line = `line coverage ${result.pct}% (${result.covered}/${result.total}); threshold ${result.threshold}%`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Coverage\n\n${result.ok ? 'PASS' : 'FAIL'}: ${line}\n`);
  if (result.ok) log(`coverage: ${line}`);
  else log(`::error title=coverage::${line}`);
  return result;
}

module.exports = { CoverageError, check, main };

if (require.main === module) {
  try {
    if (!main().ok) process.exitCode = 1;
  } catch (error) {
    console.log(`::error title=coverage::${error instanceof CoverageError ? error.message : 'unexpected failure'}`);
    process.exitCode = 1;
  }
}
