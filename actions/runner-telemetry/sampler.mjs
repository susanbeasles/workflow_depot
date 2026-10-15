// Detached sampler started by start.mjs: appends one JSON line of raw counters to the samples file every interval
// and stops writing after MAX_SAMPLES lines, so the file stays bounded (about 6 MiB). Killed by stop.mjs; the runner
// also cleans up orphan processes at the end of the job. Any error ends it quietly: telemetry is optional.
import { fileURLToPath } from 'node:url';
import { appendSample, MAX_SAMPLES, takeSample } from './lib.mjs';

export async function runSampler({ file, workspace, intervalMs, procRoot = '/proc', maxSamples = MAX_SAMPLES, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), statfs } = {}) {
  let written = 0;
  while (written < maxSamples) {
    appendSample(file, takeSample({ procRoot, workspace, now, statfs }));
    written++;
    if (written < maxSamples) await sleep(intervalMs);
  }
  return written;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, seconds, workspace] = process.argv.slice(2);
  runSampler({ file, workspace: workspace || undefined, intervalMs: Number(seconds) * 1000 }).catch(() => {}).finally(() => { process.exitCode = 0; });
}
