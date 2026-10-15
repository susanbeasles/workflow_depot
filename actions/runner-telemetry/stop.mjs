// post: stop the sampler, aggregate, write the step summary and print exactly one `##[runner-telemetry]{json}` line.
// Never fails the job: everything is caught, the step exits 0, and with nothing to report it prints only a notice.
import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { arch as osArch, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, readSamples, summaryMarkdown, takeSample, telemetryLine } from './lib.mjs';

// Only signal the pid if it is still our sampler (pid reuse after a crash must not hit an unrelated process).
export function stopSampler(pid, { procRoot = '/proc', kill = process.kill.bind(process) } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  let cmdline;
  try { cmdline = readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8'); } catch { return false; }
  if (!cmdline.split('\0').some(arg => arg.endsWith('/runner-telemetry/sampler.mjs') || arg === 'sampler.mjs')) return false;
  try { kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

const notice = (log, text) => log(`::notice title=runner-telemetry::${text}`);

export function stop(env = process.env, { platform = process.platform, procRoot = '/proc', kill, log = console.log, write = line => process.stdout.write(line),
  now = Date.now, statfs, arch = osArch(), cpuCount = availableParallelism() } = {}) {
  try {
    if (platform !== 'linux') { notice(log, `Linux only; no telemetry on ${platform}.`); return null; }
    if (env.STATE_skip === '1') return null;
    const pid = Number(env.STATE_pid), file = env.STATE_file, interval = Number(env.STATE_interval);
    if (!Number.isSafeInteger(pid) || !file || !Number.isSafeInteger(interval)) { notice(log, 'the sampler was not started; no telemetry.'); return null; }
    stopSampler(pid, { procRoot, kill });
    let samples = [];
    try { samples = readSamples(file); } catch { samples = []; }
    if (samples.length) samples.push(takeSample({ procRoot, workspace: env.GITHUB_WORKSPACE || undefined, now, statfs }));
    const t = aggregate(samples, { intervalS: interval, arch, cpuCount });
    try { rmSync(file, { force: true }); } catch { /* bounded file in RUNNER_TEMP, removed by the runner anyway */ }
    if (!t) { notice(log, 'not enough samples for telemetry (the job was shorter than one interval or sampling failed).'); return null; }
    if (env.GITHUB_STEP_SUMMARY) { try { appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(t)); } catch { /* summary is optional */ } }
    write(telemetryLine(t) + '\n');
    return t;
  } catch {
    try { notice(log, 'telemetry failed; the job is unaffected.'); } catch { /* nothing */ }
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { stop(); } catch { /* never fail the job */ }
  process.exitCode = 0;
}
