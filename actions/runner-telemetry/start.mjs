// main: start the detached sampler. Never fails the job: every error becomes a notice and the step exits 0.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInterval } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function saveState(env, values) {
  if (!env.GITHUB_STATE) throw Object.assign(new Error('no GITHUB_STATE'), { code: 'no_state_file' });
  appendFileSync(env.GITHUB_STATE, Object.entries(values).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, '')}\n`).join(''));
}

export function start(env = process.env, { platform = process.platform, spawnImpl = spawn, log = console.log, execPath = process.execPath } = {}) {
  try {
    if (platform !== 'linux') {
      log(`::notice title=runner-telemetry::Linux only; no telemetry is collected on ${platform}.`);
      saveState(env, { skip: '1' });
      return { started: false };
    }
    const { seconds, valid } = parseInterval(env['INPUT_INTERVAL-SECONDS']);
    if (!valid) log('::notice title=runner-telemetry::interval-seconds must be a whole number from 1 to 60; using 5.');
    if (!env.RUNNER_TEMP) throw Object.assign(new Error('no RUNNER_TEMP'), { code: 'no_runner_temp' });
    const dir = join(env.RUNNER_TEMP, 'runner-telemetry'), file = join(dir, 'samples.jsonl');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '');
    const child = spawnImpl(execPath, [join(HERE, 'sampler.mjs'), file, String(seconds), env.GITHUB_WORKSPACE ?? ''], { detached: true, stdio: 'ignore' });
    // spawn can return a child and emit ENOENT/EACCES on a later tick. Without
    // a listener that error terminates the action despite the surrounding try.
    child.on?.('error', () => {});
    child.unref?.();
    if (!Number.isSafeInteger(child.pid)) throw Object.assign(new Error('sampler did not start'), { code: 'spawn_failed' });
    saveState(env, { pid: child.pid, file, interval: seconds });
    return { started: true, pid: child.pid, file, interval: seconds };
  } catch (error) {
    log(`::notice title=runner-telemetry::sampler not started (${String(error?.code ?? 'error').replace(/[^A-Za-z0-9_-]/g, '_')}); the job continues without telemetry.`);
    return { started: false };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { start(); } catch { /* never fail the job */ }
  process.exitCode = 0;
}
