'use strict';
// pipeline/scripts/workdir-check.cjs: the configured working directory must stay inside the checkout. Embedded byte
// for byte in pipeline.yml (shell: node {0}); pipeline/test checks that the two match. Runs from the checkout root
// right after checkout, before any step uses the directory. ci/pipeline-config.mjs only checks the path's spelling;
// a tracked symlink in any component could still point outside the repository, so every component is lstat'ed
// (no symlinks, directories only) and the resolved path must stay under the resolved checkout root.
const { lstatSync, realpathSync } = require('node:fs');
const path = require('node:path');

const RELATIVE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

class WorkdirError extends Error {}

function check(root, dir) {
  if (dir === '.') return realpathSync(root);
  if (typeof dir !== 'string' || !RELATIVE.test(dir) || dir.split('/').some((s) => s === '.' || s === '..')) {
    throw new WorkdirError('WORKING_DIRECTORY must be . or a normalized relative path');
  }
  let current = root;
  for (const segment of dir.split('/')) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      throw new WorkdirError(`${dir}: ${path.relative(root, current)} does not exist in the checkout`);
    }
    if (stat.isSymbolicLink()) throw new WorkdirError(`${dir}: ${path.relative(root, current)} is a symlink; the working directory must be a real directory inside the checkout`);
    if (!stat.isDirectory()) throw new WorkdirError(`${dir}: ${path.relative(root, current)} is not a directory`);
  }
  const realRoot = realpathSync(root);
  const resolved = realpathSync(current);
  if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) throw new WorkdirError(`${dir} resolves outside the checkout`);
  return resolved;
}

module.exports = { WorkdirError, check };

if (require.main === module) {
  try {
    check(process.cwd(), process.env.WORKING_DIRECTORY);
    console.log(`working directory ${process.env.WORKING_DIRECTORY} is inside the checkout`);
  } catch (error) {
    console.log(`::error title=working-directory::${error instanceof WorkdirError ? error.message : 'unexpected failure'}`);
    process.exitCode = 1;
  }
}
