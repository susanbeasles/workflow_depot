'use strict';
// pipeline/scripts/coverage-check.cjs: stage 1 coverage gate. Embedded byte for byte in pipeline.yml
// (shell: node {0}); pipeline/test checks that the two match. Runs in the caller's working directory after the
// test script. COVERAGE_SUMMARY is the Istanbul json-summary path from pipeline.json and COVERAGE_MIN the line
// threshold of the policy profile, both validated by ci/pipeline-config.mjs in the config job and checked again
// here. Fails unless total.lines.pct reaches the threshold over a non-empty line count.
const { appendFileSync, lstatSync, readFileSync } = require('node:fs');
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
  const file = path.join(cwd, summaryPath);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new CoverageError(`${summaryPath} does not exist: the test script must write an Istanbul json-summary report there`);
  }
  if (!stat.isFile()) throw new CoverageError(`${summaryPath} must be a regular file, not a symlink or directory`);
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
  return { pct: lines.pct, covered: lines.covered, total: lines.total, threshold, ok: lines.pct >= threshold };
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
