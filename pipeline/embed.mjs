// pipeline/embed.mjs: copy each pipeline/scripts/*.cjs into pipeline.yml, byte for byte.
// The reusable workflow cannot load files from workflow_depot in jobs that have no checkout of it, so the
// scripts run inline (`shell: node {0}`). A step marked `# embedded: pipeline/scripts/<name>.cjs` directly
// above `run: |` gets that file as its run block. pipeline/test fails when the two drift.
//
//   node pipeline/embed.mjs           rewrite pipeline/pipeline.yml in place
//   node pipeline/embed.mjs --check   exit 1 if it would change anything
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = /^( *)# embedded: (pipeline\/scripts\/[a-z0-9-]+\.cjs)\b.*$/;

export function embed(yamlText, readScript) {
  const lines = yamlText.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const marker = MARKER.exec(lines[i]);
    out.push(lines[i]);
    if (marker === null) continue;
    const indent = marker[1];
    if (lines[i + 1] !== `${indent}run: |`) throw new Error(`line ${i + 2}: expected \`${indent}run: |\` after the embedded marker`);
    out.push(lines[i + 1]);
    i += 2;
    // Skip the old block: lines indented deeper than `run:`, and blank lines inside it.
    while (i < lines.length && (lines[i].startsWith(`${indent} `) || (lines[i] === '' && i + 1 < lines.length && lines[i + 1].startsWith(`${indent} `)))) i += 1;
    const script = readScript(marker[2]);
    if (!script.endsWith('\n') || script.endsWith('\n\n')) throw new Error(`${marker[2]} must end with exactly one newline`);
    if (script.includes('${{')) throw new Error(`${marker[2]} contains \`\${{\`, which Actions would expand`);
    for (const line of script.slice(0, -1).split('\n')) out.push(line === '' ? '' : `${indent}  ${line}`);
    i -= 1;
  }
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = path.join(ROOT, 'pipeline', 'pipeline.yml');
  const before = readFileSync(file, 'utf8');
  const after = embed(before, (rel) => readFileSync(path.join(ROOT, rel), 'utf8'));
  if (process.argv.includes('--check')) {
    if (after !== before) {
      console.error('pipeline/pipeline.yml is out of date with pipeline/scripts: run `node pipeline/embed.mjs`');
      process.exitCode = 1;
    }
  } else if (after !== before) {
    writeFileSync(file, after);
    console.log('pipeline/pipeline.yml updated');
  } else {
    console.log('pipeline/pipeline.yml already up to date');
  }
}
