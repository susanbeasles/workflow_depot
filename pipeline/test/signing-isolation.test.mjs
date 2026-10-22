import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const workflow = JSON.parse(execFileSync('python3', ['-c', 'import json,yaml; print(json.dumps(yaml.load(open("pipeline/pipeline.yml"), Loader=yaml.BaseLoader)))'], {encoding:'utf8'}));
test('candidate execution cannot request signing credentials', () => {
  const jobs = Object.values(workflow.jobs).filter(j => j.steps.some(s => /eval "\$CMD"/.test(s.run ?? '')));
  assert.ok(jobs.length);
  for (const job of jobs) {
    assert.equal(job.permissions['id-token'], undefined);
    assert.equal(job.permissions.attestations, undefined);
  }
});
test('signer hashes opaque bytes and rejects ambiguous or linked artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signer-data-'));
  const artifact = join(dir, 'payload');
  const output = join(dir, 'output');
  const script = resolve('pipeline/scripts/hash-artifact.cjs');
  const run = () => execFileSync(process.execPath, [script], {env:{ARTIFACT_DIR:artifact,GITHUB_OUTPUT:output},stdio:'pipe'});
  try {
    execFileSync('mkdir',[artifact]);
    const payload = Buffer.from('process.exit(99); // opaque candidate bytes');
    writeFileSync(join(artifact,'candidate.js'),payload);
    run();
    assert.equal(readFileSync(output,'utf8'), `artifact_digest=sha256:${createHash('sha256').update(payload).digest('hex')}\n`);
    writeFileSync(join(artifact,'extra'),'second artifact');
    assert.throws(run);
    rmSync(join(artifact,'extra'));
    rmSync(join(artifact,'candidate.js'));
    symlinkSync(output,join(artifact,'linked'));
    assert.throws(run);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('required build check attests immutable same-run data on a fresh runner', () => {
  const signer = workflow.jobs.build;
  assert.equal(signer.needs, 'build-candidate');
  assert.ok(!signer.steps.some(s => s.uses?.startsWith('actions/checkout@') || s.uses?.startsWith('actions/setup-node@')));
  const download = signer.steps.find(s => s.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['artifact-ids'], '${{ needs.build-candidate.outputs.artifact_id }}');
  assert.ok(!download.with['run-id']);
  assert.ok(!download.with.repository);
  assert.equal(signer.outputs.artifact_digest, '${{ steps.digest.outputs.artifact_digest }}');
});
