// runner-telemetry: read Linux counters, aggregate samples, render the step summary and the one log line the
// ghcaretaker collector parses. No dependencies. The proc root is a parameter so tests can use fixture files.
//
// The emitted object holds numeric aggregates plus os, arch and cpu count only: no environment variables, paths,
// hostnames, process names or command lines. Keep the key set in step with ghcaretaker src/telemetry.mjs.
import { appendFileSync, readFileSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA = 'runner-telemetry/v1';
export const MARKER = '##[runner-telemetry]';
export const MAX_SAMPLES = 20_000;
export const DEFAULT_INTERVAL_S = 5;
const MAX_SAMPLE_FILE = 16 * 1024 * 1024;
const SECTOR = 512; // /proc/diskstats always counts 512-byte sectors
// Whole-disk devices only (partitions, loop, ram, zram, device-mapper and md would double count or are virtual).
const WHOLE_DISK = /^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export const KEYS = Object.freeze(['schema', 'os', 'arch', 'cpu_count', 'memory_total_bytes', 'samples', 'duration_s', 'interval_s',
  'cpu_mean', 'cpu_p95', 'cpu_max', 'memory_used_max_bytes', 'memory_used_mean_bytes', 'disk_read_bytes', 'disk_write_bytes',
  'net_rx_bytes', 'net_tx_bytes', 'load1_max', 'disk_free_min_bytes']);

const read = (procRoot, name) => readFileSync(join(procRoot, name), 'utf8');
const safe = fn => { try { const v = fn(); return v === undefined ? null : v; } catch { return null; } };
const int = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);

export function parseInterval(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { seconds: DEFAULT_INTERVAL_S, valid: true };
  const text = String(raw).trim();
  const n = /^\d{1,2}$/.test(text) ? Number(text) : NaN;
  return n >= 1 && n <= 60 ? { seconds: n, valid: true } : { seconds: DEFAULT_INTERVAL_S, valid: false };
}

/** Aggregate CPU line of /proc/stat: busy and total jiffies over all cores (guest time is already in user/nice). */
export function readCpu(procRoot) {
  const line = read(procRoot, 'stat').split('\n').find(l => /^cpu\s/.test(l));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (f.length < 4 || f.some(v => !Number.isSafeInteger(v) || v < 0)) return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { busy: total - idle - iowait, total };
}

export function readMem(procRoot) {
  const kb = {};
  for (const line of read(procRoot, 'meminfo').split('\n')) {
    const m = /^(MemTotal|MemAvailable):\s+(\d+)\s*kB$/.exec(line.trim());
    if (m) kb[m[1]] = Number(m[2]);
  }
  if (!Number.isSafeInteger(kb.MemTotal) || !Number.isSafeInteger(kb.MemAvailable)) return null;
  return { total: kb.MemTotal * 1024, available: kb.MemAvailable * 1024 };
}

export function readLoad(procRoot) {
  const v = Number(read(procRoot, 'loadavg').trim().split(/\s+/)[0]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export function readDisk(procRoot) {
  let rd = 0, wr = 0, seen = false;
  for (const line of read(procRoot, 'diskstats').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !WHOLE_DISK.test(f[2])) continue;
    const sr = Number(f[5]), sw = Number(f[9]);
    if (!Number.isSafeInteger(sr) || !Number.isSafeInteger(sw)) continue;
    rd += sr * SECTOR; wr += sw * SECTOR; seen = true;
  }
  return seen ? { read: rd, write: wr } : null;
}

export function readNet(procRoot) {
  let rx = 0, tx = 0, seen = false;
  for (const line of read(procRoot, 'net/dev').split('\n').slice(2)) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === 'lo') continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length < 9 || !Number.isSafeInteger(f[0]) || !Number.isSafeInteger(f[8])) continue;
    rx += f[0]; tx += f[8]; seen = true;
  }
  return seen ? { rx, tx } : null;
}

export function readFree(path, statfs = statfsSync) {
  if (!path) return null;
  const s = statfs(path);
  return int(Number(s.bavail) * Number(s.bsize));
}

/** One sample of raw cumulative counters; any unreadable source is null, never guessed. */
export function takeSample({ procRoot = '/proc', workspace, now = Date.now, statfs = statfsSync } = {}) {
  const cpu = safe(() => readCpu(procRoot)), mem = safe(() => readMem(procRoot)), disk = safe(() => readDisk(procRoot)), net = safe(() => readNet(procRoot));
  return {
    t: now(), cpu_busy: cpu?.busy ?? null, cpu_total: cpu?.total ?? null, mem_total: mem?.total ?? null, mem_available: mem?.available ?? null,
    load1: safe(() => readLoad(procRoot)), disk_read: disk?.read ?? null, disk_write: disk?.write ?? null, net_rx: net?.rx ?? null, net_tx: net?.tx ?? null,
    disk_free: safe(() => readFree(workspace, statfs)),
  };
}

export const appendSample = (file, sample) => appendFileSync(file, JSON.stringify(sample) + '\n');

/** Samples written by the sampler; a torn last line (killed mid-write) or any malformed line is skipped. */
export function readSamples(file) {
  if (statSync(file).size > MAX_SAMPLE_FILE) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || out.length >= MAX_SAMPLES) continue;
    try { const s = JSON.parse(line); if (s && Number.isSafeInteger(s.t)) out.push(s); } catch { /* skip */ }
  }
  return out;
}

export function percentile(values, p) {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))] : null;
}
const round = (v, digits) => (v === null ? null : Number(v.toFixed(digits)));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Sum of positive steps between consecutive readings (a counter reset is skipped, not subtracted).
function counterDelta(samples, key) {
  let total = 0, pairs = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = int(samples[i - 1][key]), b = int(samples[i][key]);
    if (a === null || b === null) continue;
    pairs++;
    if (b >= a) total += b - a;
  }
  return pairs ? total : null;
}

/** Aggregate at least two samples into the runner-telemetry/v1 object; null when there is nothing to report. */
export function aggregate(samples, { intervalS, arch, cpuCount }) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const list = samples.slice(-(MAX_SAMPLES + 1));
  const cpu = [];
  let busyTotal = 0, cpuTotal = 0;
  for (let i = 1; i < list.length; i++) {
    const db = num(list[i].cpu_busy) - num(list[i - 1].cpu_busy), dt = num(list[i].cpu_total) - num(list[i - 1].cpu_total);
    if ([list[i].cpu_busy, list[i - 1].cpu_busy, list[i].cpu_total, list[i - 1].cpu_total].some(v => num(v) === null) || dt <= 0 || db < 0) continue;
    cpu.push(Math.min(1, Math.max(0, db / dt)));
    busyTotal += Math.min(db, dt);
    cpuTotal += dt;
  }
  const used = list.filter(s => int(s.mem_total) !== null && int(s.mem_available) !== null && s.mem_available <= s.mem_total).map(s => s.mem_total - s.mem_available);
  const totals = list.map(s => int(s.mem_total)).filter(v => v !== null);
  const loads = list.map(s => num(s.load1)).filter(v => v !== null && v >= 0);
  const free = list.map(s => int(s.disk_free)).filter(v => v !== null);
  const duration = (list.at(-1).t - list[0].t) / 1000;
  const out = {
    schema: SCHEMA, os: 'linux', arch: /^[a-z0-9_]{1,16}$/.test(arch ?? '') ? arch : 'unknown',
    cpu_count: Number.isSafeInteger(cpuCount) && cpuCount >= 1 ? Math.min(cpuCount, 4096) : 1,
    memory_total_bytes: totals.length ? Math.max(...totals) : null,
    samples: list.length, duration_s: round(Math.max(0, duration), 1), interval_s: intervalS,
    cpu_mean: cpu.length ? round(busyTotal / cpuTotal, 4) : null,
    cpu_p95: cpu.length ? round(percentile(cpu, 95), 4) : null,
    cpu_max: cpu.length ? round(Math.max(...cpu), 4) : null,
    memory_used_max_bytes: used.length ? Math.max(...used) : null,
    memory_used_mean_bytes: used.length ? Math.round(used.reduce((a, b) => a + b, 0) / used.length) : null,
    disk_read_bytes: counterDelta(list, 'disk_read'), disk_write_bytes: counterDelta(list, 'disk_write'),
    net_rx_bytes: counterDelta(list, 'net_rx'), net_tx_bytes: counterDelta(list, 'net_tx'),
    load1_max: loads.length ? round(Math.max(...loads), 2) : null,
    disk_free_min_bytes: free.length ? Math.min(...free) : null,
  };
  return Object.fromEntries(KEYS.map(k => [k, out[k]]));
}

export const telemetryLine = t => MARKER + JSON.stringify(t);

const pct = v => (v === null ? 'missing' : (v * 100).toFixed(0) + '%');
export function bytes(b) {
  if (b === null) return 'missing';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = b, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
}

export function summaryMarkdown(t) {
  const rows = [
    ['CPU mean / p95 / max (all cores)', `${pct(t.cpu_mean)} / ${pct(t.cpu_p95)} / ${pct(t.cpu_max)}`],
    ['Memory used peak / mean', `${bytes(t.memory_used_max_bytes)} / ${bytes(t.memory_used_mean_bytes)} of ${bytes(t.memory_total_bytes)}`],
    ['Disk read / write', `${bytes(t.disk_read_bytes)} / ${bytes(t.disk_write_bytes)}`],
    ['Network received / sent', `${bytes(t.net_rx_bytes)} / ${bytes(t.net_tx_bytes)}`],
    ['Load average (1 min) peak', t.load1_max === null ? 'missing' : String(t.load1_max)],
    ['Workspace disk free, lowest', bytes(t.disk_free_min_bytes)],
    ['Samples', `${t.samples} over ${t.duration_s} s, every ${t.interval_s} s`],
    ['Runner', `${t.os} ${t.arch}, ${t.cpu_count} CPUs`],
  ];
  return `### Runner telemetry\n\n| Measure | Value |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n\nMeasured from /proc on the runner; "missing" means the counter was not readable.\n`;
}
