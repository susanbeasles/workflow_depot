'use strict';
// pipeline/scripts/package.cjs: package the build output deterministically and digest it.
// Embedded byte for byte in pipeline.yml (shell: node {0}); pipeline/test checks that the two match.
// ARTIFACT_PATH empty: `npm pack --ignore-scripts` (npm normalizes order and mtimes). A file: used as is.
// A directory: GNU tar with sorted names, mtime 0, numeric owner 0 and normalized modes, then gzip with
// mtime 0. Writes artifact_file, artifact_name and artifact_digest (sha256:<hex>) to GITHUB_OUTPUT.
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { gzipSync } = require('node:zlib');

const SAFE_NAME = /^[A-Za-z0-9._@+-]+$/;

class PackageError extends Error {}

function digestFile(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function npmPack(cwd, outDir, run) {
  if (!existsSync(path.join(cwd, 'package.json'))) throw new PackageError('no package.json: set the `artifact-path` input to the file or directory to package');
  const out = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outDir], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let filename;
  try {
    filename = JSON.parse(out)[0].filename;
  } catch {
    throw new PackageError('npm pack printed no JSON result');
  }
  if (typeof filename !== 'string') throw new PackageError('npm pack printed no filename');
  // Scoped packages are named scope-name-version.tgz; anything else is refused rather than guessed.
  const file = path.join(outDir, filename);
  if (!SAFE_NAME.test(filename) || !existsSync(file)) throw new PackageError(`npm pack output ${filename} not found`);
  return file;
}

function tarDirectory(dir, outDir, run) {
  const name = path.basename(dir);
  const tar = run('tar', [
    '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go+rX,go-w',
    '--format=posix', '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime',
    '-C', path.dirname(dir), '-cf', '-', '--', name,
  ], { maxBuffer: 2 * 1024 * 1024 * 1024 });
  const file = path.join(outDir, `${name}.tar.gz`);
  writeFileSync(file, gzipSync(tar, { level: 9 }));
  return file;
}

function packageArtifact({ artifactPath = '', cwd = process.cwd(), workspace = cwd, outDir }, run = execFileSync) {
  if (!outDir) throw new PackageError('no output directory');
  mkdirSync(outDir, { recursive: true });
  let file;
  if (artifactPath.trim() === '') {
    file = npmPack(cwd, outDir, run);
  } else {
    const source = path.resolve(cwd, artifactPath);
    if (!existsSync(source)) throw new PackageError(`artifact-path ${artifactPath} does not exist after the build`);
    const real = realpathSync(source);
    if (!inside(realpathSync(workspace), real)) throw new PackageError(`artifact-path ${artifactPath} is outside the workspace`);
    const name = path.basename(real);
    if (!SAFE_NAME.test(name)) throw new PackageError(`artifact name ${name} must match ${SAFE_NAME}`);
    if (statSync(real).isDirectory()) {
      file = tarDirectory(real, outDir, run);
    } else {
      file = path.join(outDir, name);
      copyFileSync(real, file);
    }
  }
  return { artifact_file: file, artifact_name: path.basename(file), artifact_digest: digestFile(file) };
}

function main(env = process.env, log = console.log) {
  const result = packageArtifact({ artifactPath: env.ARTIFACT_PATH ?? '', cwd: process.cwd(), workspace: env.GITHUB_WORKSPACE || process.cwd(), outDir: env.OUT_DIR });
  if (env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(result)) appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  log(`packaged ${result.artifact_name} ${result.artifact_digest}`);
  return result;
}

module.exports = { PackageError, digestFile, packageArtifact, main };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.log(`::error title=package::${error instanceof PackageError ? error.message : `unexpected failure: ${error.message}`}`.replace(/[\r\n]+/g, ' '));
    process.exitCode = 1;
  }
}
