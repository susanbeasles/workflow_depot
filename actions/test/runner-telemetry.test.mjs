import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCpu, readMem, readLoad, readDisk, readNet, readFree, takeSample, aggregate, telemetryLine, summaryMarkdown, parseInterval, percentile, KEYS, MARKER, MAX_SAMPLES } from '../runner-telemetry/lib.mjs';
import { runSampler } from '../runner-telemetry/sampler.mjs';
import { start } from '../runner-telemetry/start.mjs';
import { stop, stopSampler } from '../runner-telemetry/stop.mjs';

// Fixture /proc: values chosen so every aggregate can be checked by hand.
function procRoot({ cpu = [100, 0, 100, 800, 0, 0, 0, 0], memTotalKb = 16_000_000, memAvailKb = 12_000_000, load = '0.50 0.40 0.30 1/100 4242', sda = [1000, 2000], nvme = [10, 20], eth0 = [5000, 600], lo = [999999, 999999] } = {}, dir) {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'proc-'));
  mkdirSync(join(root, 'net'), { recursive: true });
  writeFileSync(join(root, 'stat'), `cpu  ${cpu.join(' ')} 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\nintr 1 2 3\n`);
  writeFileSync(join(root, 'meminfo'), `MemTotal:       ${memTotalKb} kB\nMemFree:         1000 kB\nMemAvailable:   ${memAvailKb} kB\nBuffers:          10 kB\n`);
  writeFileSync(join(root, 'loadavg'), load + '\n');
  const disk = (maj, min, name, [r, w]) => `   ${maj}       ${min} ${name} 10 0 ${r} 5 20 0 ${w} 7 0 9 12 0 0 0 0`;
  writeFileSync(join(root, 'diskstats'), [disk(8, 0, 'sda', sda), disk(8, 1, 'sda1', [77777, 77777]), disk(259, 0, 'nvme0n1', nvme), disk(259, 1, 'nvme0n1p1', [5, 5]), disk(7, 0, 'loop0', [9999, 9999]), disk(253, 0, 'dm-0', [8888, 8888])].join('\n') + '\n');
  writeFileSync(join(root, 'net/dev'), `Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: ${lo[0]}  10 0 0 0 0 0 0 ${lo[1]} 10 0 0 0 0 0 0\n  eth0: ${eth0[0]} 50 0 0 0 0 0 0 ${eth0[1]} 40 0 0 0 0 0 0\n`);
  return root;
}
const statfs = free => () => ({ bavail: free / 4096, bsize: 4096 });

test('readers parse fixture /proc files: busy jiffies, MemAvailable, whole disks only, lo excluded', () => {
  const root = procRoot();
  assert.deepEqual(readCpu(root), { busy: 200, total: 1000 });
  assert.deepEqual(readMem(root), { total: 16_000_000 * 1024, available: 12_000_000 * 1024 });
  assert.equal(readLoad(root), 0.5);
  assert.deepEqual(readDisk(root), { read: (1000 + 10) * 512, write: (2000 + 20) * 512 }, 'sda + nvme0n1; partitions, loop and dm excluded');
  assert.deepEqual(readNet(root), { rx: 5000, tx: 600 });
  assert.equal(readFree('/ws', statfs(8192)), 8192);
  assert.equal(readFree(undefined), null);
  const s = takeSample({ procRoot: join(root, 'missing'), workspace: undefined, now: () => 1 });
  assert.deepEqual(Object.values(s).filter(v => v !== null), [1], 'unreadable sources are null, never guessed');
});

test('aggregation math: cpu mean/p95/max from deltas, memory peak/mean, counter deltas skip resets, load max, free min', () => {
  const base = { mem_total: 1000, load1: 0.5, disk_free: 900 };
  const samples = [
    { t: 0, cpu_busy: 0, cpu_total: 0, mem_available: 800, disk_read: 100, disk_write: 0, net_rx: 0, net_tx: 0, ...base },
    { t: 5000, cpu_busy: 50, cpu_total: 100, mem_available: 600, disk_read: 300, disk_write: 10, net_rx: 1000, net_tx: 10, ...base, load1: 2.25 },
    { t: 10000, cpu_busy: 60, cpu_total: 200, mem_available: 700, disk_read: 50, disk_write: 30, net_rx: 1500, net_tx: 30, ...base, disk_free: 400 }, // disk_read reset
    { t: 15000, cpu_busy: 160, cpu_total: 300, mem_available: 500, disk_read: 150, disk_write: 30, net_rx: 1500, net_tx: 30, ...base },
  ];
  const t = aggregate(samples, { intervalS: 5, arch: 'x64', cpuCount: 4 });
  assert.deepEqual(Object.keys(t), KEYS);
  assert.equal(t.cpu_mean, round((0.5 + 0.1 + 1) / 3)); assert.equal(t.cpu_p95, 1); assert.equal(t.cpu_max, 1);
  assert.equal(t.memory_used_max_bytes, 500); assert.equal(t.memory_used_mean_bytes, Math.round((200 + 400 + 300 + 500) / 4));
  assert.equal(t.disk_read_bytes, 200 + 100, 'the reset step is skipped, not subtracted'); assert.equal(t.disk_write_bytes, 30);
  assert.equal(t.net_rx_bytes, 1500); assert.equal(t.net_tx_bytes, 30);
  assert.equal(t.load1_max, 2.25); assert.equal(t.disk_free_min_bytes, 400);
  assert.equal(t.samples, 4); assert.equal(t.duration_s, 15); assert.equal(t.memory_total_bytes, 1000);
  assert.equal(aggregate(samples.slice(0, 1), { intervalS: 5 }), null, 'one sample: nothing to report');
  const blind = aggregate(samples.map(s => ({ t: s.t })), { intervalS: 5, arch: 'arm64', cpuCount: 2 });
  assert.equal(blind.cpu_mean, null); assert.equal(blind.disk_read_bytes, null); assert.equal(blind.memory_used_max_bytes, null, 'missing stays missing, never zero');
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});
const round = v => Number(v.toFixed(4));

test('CPU mean weights unequal sample intervals by their total CPU time', () => {
  const t = aggregate([
    { t: 0, cpu_busy: 0, cpu_total: 0 },
    { t: 10000, cpu_busy: 500, cpu_total: 1000 },
    { t: 11000, cpu_busy: 600, cpu_total: 1100 },
  ], { intervalS: 10, arch: 'x64', cpuCount: 1 });
  assert.equal(t.cpu_mean, round(600 / 1100));
  assert.equal(t.cpu_max, 1);
});

test('the output line: one marker, schema v1, numbers plus os/arch/cpu count only (no env, paths, hosts or commands)', () => {
  const t = aggregate([{ t: 0, cpu_busy: 0, cpu_total: 0 }, { t: 1000, cpu_busy: 1, cpu_total: 2 }], { intervalS: 1, arch: 'x64', cpuCount: 2 });
  const line = telemetryLine(t);
  assert.ok(line.startsWith(MARKER + '{')); assert.ok(!line.includes('\n'));
  const parsed = JSON.parse(line.slice(MARKER.length));
  assert.equal(parsed.schema, 'runner-telemetry/v1');
  for (const [k, v] of Object.entries(parsed)) {
    if (['schema', 'os', 'arch'].includes(k)) assert.equal(typeof v, 'string');
    else assert.ok(v === null || typeof v === 'number', k);
  }
  assert.equal(aggregate([{ t: 0 }, { t: 1 }], { intervalS: 1, arch: 'x64; rm -rf /', cpuCount: 2 }).arch, 'unknown');
  assert.match(summaryMarkdown(t), /\| CPU mean \/ p95 \/ max \(all cores\) \| 50% \/ 50% \/ 50% \|/);
  assert.match(summaryMarkdown(t), /Memory used peak \/ mean \| missing \/ missing of missing/);
});

test('the sample file is bounded: the sampler stops writing after 20,000 samples', async () => {
  const root = procRoot(), dir = mkdtempSync(join(tmpdir(), 'samples-')), file = join(dir, 'samples.jsonl');
  let sleeps = 0, clock = 0;
  const written = await runSampler({ file, procRoot: root, workspace: dir, intervalMs: 5000, sleep: async () => { sleeps++; clock += 5000; }, now: () => clock, statfs: statfs(4096) });
  assert.equal(written, MAX_SAMPLES); assert.equal(sleeps, MAX_SAMPLES - 1);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 20_000);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['cpu_busy', 'cpu_total', 'disk_free', 'disk_read', 'disk_write', 'load1', 'mem_available', 'mem_total', 'net_rx', 'net_tx', 't']);
});

function actionEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-'));
  const files = { state: join(dir, 'state'), summary: join(dir, 'summary'), temp: join(dir, 'temp'), ws: join(dir, 'ws') };
  mkdirSync(files.temp); mkdirSync(files.ws); writeFileSync(files.state, ''); writeFileSync(files.summary, '');
  return { files, env: { GITHUB_STATE: files.state, GITHUB_STEP_SUMMARY: files.summary, RUNNER_TEMP: files.temp, GITHUB_WORKSPACE: files.ws, ...extra } };
}
const stateOf = file => Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => [`STATE_${l.slice(0, l.indexOf('='))}`, l.slice(l.indexOf('=') + 1)]));

test('start spawns a detached sampler with the interval; stop kills only our sampler, writes the summary and one line', () => {
  const { env, files } = actionEnv({ 'INPUT_INTERVAL-SECONDS': '7' });
  const spawned = [];
  const r = start(env, { platform: 'linux', spawnImpl: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { pid: 4242, unref() {} }; }, log: () => {} });
  assert.equal(r.started, true);
  assert.equal(spawned[0].args[0].endsWith('/runner-telemetry/sampler.mjs'), true);
  assert.deepEqual(spawned[0].args.slice(1), [join(files.temp, 'runner-telemetry', 'samples.jsonl'), '7', files.ws]);
  assert.equal(spawned[0].opts.detached, true); assert.equal(spawned[0].opts.stdio, 'ignore');
  const state = stateOf(files.state);
  assert.equal(state.STATE_pid, '4242'); assert.equal(state.STATE_interval, '7');
  // Two samples from the fixture proc, then stop (which adds a final one).
  const root = procRoot();
  mkdirSync(join(root, '4242')); writeFileSync(join(root, '4242', 'cmdline'), `/usr/bin/node\0${spawned[0].args[0]}\0x\0`);
  let clock = 0;
  for (const cpu of [[100, 0, 100, 800], [150, 0, 150, 900]]) { procRoot({ cpu: [...cpu, 0, 0, 0, 0] }, root); writeFileSync(state.STATE_file, readFileSync(state.STATE_file, 'utf8') + JSON.stringify(takeSample({ procRoot: root, workspace: files.ws, now: () => clock, statfs: statfs(1 << 30) })) + '\n'); clock += 7000; }
  procRoot({ cpu: [250, 0, 250, 900, 0, 0, 0, 0] }, root);
  const killed = [], out = [];
  const t = stop({ ...env, ...state }, { platform: 'linux', procRoot: root, kill: (pid, sig) => killed.push([pid, sig]), write: l => out.push(l), log: () => {}, now: () => clock, statfs: statfs(1 << 30), arch: 'x64', cpuCount: 4 });
  assert.deepEqual(killed, [[4242, 'SIGTERM']]);
  assert.equal(out.length, 1, 'exactly one line'); assert.ok(out[0].startsWith('##[runner-telemetry]{"schema":"runner-telemetry/v1"'));
  assert.equal(t.samples, 3); assert.equal(t.cpu_max, 1); assert.equal(t.cpu_mean, round((0.5 + 1) / 2));
  assert.match(readFileSync(files.summary, 'utf8'), /### Runner telemetry/);
  assert.equal(existsSync(state.STATE_file), false, 'sample file discarded');
  // A reused pid that is not our sampler is never signalled.
  writeFileSync(join(root, '4242', 'cmdline'), '/usr/sbin/sshd\0-D\0');
  assert.equal(stopSampler(4242, { procRoot: root, kill: () => { throw new Error('must not kill'); } }), false);
  assert.equal(stopSampler(1, { procRoot: root, kill: () => { throw new Error('must not kill'); } }), false);
});

test('non-Linux: a notice, no sampler, no line, no summary', () => {
  const { env, files } = actionEnv();
  const logs = [], spawned = [];
  assert.deepEqual(start(env, { platform: 'darwin', spawnImpl: () => spawned.push(1), log: l => logs.push(l) }), { started: false });
  assert.equal(spawned.length, 0); assert.match(logs[0], /^::notice title=runner-telemetry::Linux only/);
  const out = [];
  assert.equal(stop({ ...env, ...stateOf(files.state) }, { platform: 'win32', write: l => out.push(l), log: l => logs.push(l) }), null);
  assert.equal(out.length, 0); assert.equal(readFileSync(files.summary, 'utf8'), '');
  assert.match(logs.at(-1), /Linux only; no telemetry on win32/);
});

test('never fails the job: bad input, missing runner files, spawn errors and stop without state are notices only', () => {
  const logs = [];
  assert.deepEqual(parseInterval('0'), { seconds: 5, valid: false }); assert.deepEqual(parseInterval('61'), { seconds: 5, valid: false });
  assert.deepEqual(parseInterval('5; rm'), { seconds: 5, valid: false }); assert.deepEqual(parseInterval('60'), { seconds: 60, valid: true });
  assert.deepEqual(parseInterval(''), { seconds: 5, valid: true });
  const { env } = actionEnv({ 'INPUT_INTERVAL-SECONDS': 'abc' });
  assert.equal(start(env, { platform: 'linux', spawnImpl: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }, log: l => logs.push(l) }).started, false);
  assert.ok(logs.some(l => /using 5/.test(l))); assert.ok(logs.some(l => /sampler not started \(EACCES\)/.test(l)));
  assert.equal(start({}, { platform: 'linux', log: l => logs.push(l) }).started, false);
  const out = [];
  assert.equal(stop({}, { platform: 'linux', write: l => out.push(l), log: l => logs.push(l) }), null);
  assert.equal(stop({ STATE_pid: '5', STATE_file: '/nonexistent/x', STATE_interval: '5' }, { platform: 'linux', procRoot: procRoot(), write: l => out.push(l), log: l => logs.push(l) }), null);
  assert.equal(stop({ STATE_pid: '5', STATE_file: '/x', STATE_interval: '5' }, { platform: 'linux', write: () => { throw new Error('stdout closed'); }, log: () => { throw new Error('also broken'); } }), null);
  assert.equal(out.length, 0);
});

test('an asynchronous spawn failure never crashes the telemetry action process', () => {
  const { env, files } = actionEnv();
  const module = new URL('../runner-telemetry/start.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { start } from ${JSON.stringify(module)}; start(${JSON.stringify(env)}, { execPath: ${JSON.stringify(join(files.temp, 'missing-node'))} });`],
  { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sampler not started/);
  assert.equal(result.stderr, '');
});

test('real process on this Linux host: the detached sampler runs and stop emits a valid line', { skip: process.platform !== 'linux' }, async () => {
  const { env, files } = actionEnv({ 'INPUT_INTERVAL-SECONDS': '1' });
  const r = start(env, { platform: 'linux', log: () => {} });
  assert.equal(r.started, true);
  await new Promise(resolve => setTimeout(resolve, 1500));
  const out = [];
  const t = stop({ ...env, ...stateOf(files.state) }, { platform: 'linux', write: l => out.push(l), log: () => {} });
  assert.ok(t, 'telemetry produced'); assert.equal(out.length, 1);
  assert.ok(t.samples >= 2); assert.ok(t.cpu_count >= 1); assert.ok(t.memory_total_bytes > 0);
  await new Promise(resolve => setTimeout(resolve, 200));
  let alive = true;
  try { process.kill(r.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the sampler was stopped');
});
