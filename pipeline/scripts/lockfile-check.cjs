'use strict';
// pipeline/scripts/lockfile-check.cjs: the npm lockfile exists, matches package.json and pins every
// downloaded package by integrity. Embedded byte for byte in pipeline.yml (shell: node {0});
// pipeline/test checks that the two match. Runs in the caller's working directory. `npm ci` in
// lint-test and build is the full drift check; this fails fast, offline, with a clear reason.
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function sameMap(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => a[key] !== b[key]).sort();
}

/** Returns {errors, warnings, skipped, packages} for the npm project in `dir`. */
function check(dir) {
  const result = { errors: [], warnings: [], skipped: false, packages: 0 };
  if (!existsSync(path.join(dir, 'package.json'))) {
    result.skipped = true;
    return result;
  }
  const lockName = ['npm-shrinkwrap.json', 'package-lock.json'].find((name) => existsSync(path.join(dir, name)));
  if (lockName === undefined) {
    result.errors.push('package.json has no package-lock.json: run `npm install` and commit the lockfile');
    return result;
  }
  let manifest;
  let lock;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    lock = JSON.parse(readFileSync(path.join(dir, lockName), 'utf8'));
  } catch (error) {
    result.errors.push(`cannot parse package.json or ${lockName}: ${error.message}`);
    return result;
  }
  if (!Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 2 || typeof lock.packages !== 'object' || lock.packages === null) {
    result.errors.push(`${lockName} is lockfileVersion ${lock.lockfileVersion}; regenerate it with npm 7 or later`);
    return result;
  }
  const root = lock.packages[''] ?? {};
  for (const field of DEP_FIELDS) {
    const drift = sameMap(manifest[field], root[field]);
    if (drift.length > 0) result.errors.push(`${lockName} is out of date with package.json ${field}: ${drift.join(', ')} (run \`npm install\`)`);
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry === null || typeof entry !== 'object' || entry.link === true || entry.inBundle === true) continue;
    result.packages += 1;
    const resolved = entry.resolved;
    if (resolved === undefined) continue;
    if (typeof resolved !== 'string' || !resolved.startsWith('https://')) {
      result.errors.push(`${key} resolves to ${String(resolved).slice(0, 120)}: only https registry tarballs with an integrity hash are allowed`);
      continue;
    }
    if (typeof entry.integrity !== 'string' || entry.integrity === '') {
      result.errors.push(`${key} has no integrity hash`);
    } else if (!/(^|\s)sha512-/.test(entry.integrity)) {
      result.warnings.push(`${key} is pinned by ${entry.integrity.split('-')[0]} only (the registry publishes no sha512 for it)`);
    }
  }
  return result;
}

/** Escape a value for a workflow command: lockfile text is PR content and must not inject commands. */
function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function main(dir = process.cwd(), log = console.log) {
  const result = check(dir);
  if (result.skipped) {
    log('lockfile-check: no package.json here; not an npm project, nothing to check');
    return true;
  }
  for (const warning of result.warnings) log(`::warning title=lockfile::${escapeData(warning)}`);
  for (const error of result.errors) log(`::error title=lockfile::${escapeData(error)}`);
  log(`lockfile-check: ${result.packages} package(s), ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
  return result.errors.length === 0;
}

module.exports = { check, escapeData, main };

if (require.main === module) {
  if (!main()) process.exitCode = 1;
}
