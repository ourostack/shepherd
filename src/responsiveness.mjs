// The responsiveness bar: is this Mac still answering while agents load it? Each pass takes three counts-only readings:
// the load average, the memory pressure level and pages swapped in per second, how long `git rev-parse HEAD` takes in a
// few session worktrees, and how long the app's socket takes to say hello. Readings are kept for a day in
// responsiveness.jsonl (numbers only: no names, paths or session ids) and judged at the 95th percentile against a
// target: the app under 2 s, git under 1 s, memory pressure below critical, swap-ins under 1,000 pages a second.
// How full swap is stays in each reading for the record but is not a bar: macOS adds swap files as it needs them, so the
// percentage sits near full by design, and on this Mac it did not move with git or app slowness (correlation 0.05).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appReady } from './socket.mjs';

export const TARGETS = { appMs: 2000, gitMs: 1000, pressure: 4, swapInsPerSec: 1000 };
// When the Mac is short of memory right now, as the duties that shed load judge it (swap fullness is not a signal):
// the pressure level is warning or critical, pages are swapped in at the bar's rate, or they are swapped in steadily
// while the load is high.
export const STRESS = { pressure: 2, swapInsPerSec: TARGETS.swapInsPerSec, busySwapIns: 200, loadPerCore: 1.5 };
export function memoryStress({ pressure = null, swapInsPerSec = null, load1 = null, cores = 1 } = {}, t = STRESS) {
  const why = [];
  if (pressure !== null && pressure >= t.pressure) why.push(`memory pressure ${pressure === 2 ? 'warning' : 'critical'}`);
  if (swapInsPerSec !== null && swapInsPerSec >= t.swapInsPerSec) why.push(`${swapInsPerSec} pages a second swapped in`);
  else if (swapInsPerSec !== null && swapInsPerSec >= t.busySwapIns && load1 !== null && load1 / cores >= t.loadPerCore) why.push(`${swapInsPerSec} pages a second swapped in under load ${load1} on ${cores} cores`);
  return { pressure, swapInsPerSec, load1, cores, stressed: why.length > 0, why: why.join(', ') };
}

// One live reading for the duties: the pressure level, the swap-in rate over `windowMs`, and the load. A probe that fails leaves its number unknown.
export async function readStress(probes, windowMs = 2000, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const pressure = await probes.pressure().catch(() => null);
  const first = await probes.swapIns().catch(() => null);
  let swapInsPerSec = null;
  if (first !== null) {
    await wait(windowMs);
    const second = await probes.swapIns().catch(() => null);
    if (second !== null && second >= first) swapInsPerSec = Math.round((second - first) / (windowMs / 1000));
  }
  const [load1] = probes.loadavg();
  return memoryStress({ pressure, swapInsPerSec, load1: Math.round(load1 * 10) / 10, cores: probes.cores() });
}

export const KEEP_MS = 24 * 3600000;
export const WORKTREES = 3;
export const FILE = 'responsiveness.jsonl';
const WORKTREE_SQL = "SELECT w.path AS path FROM sessions s JOIN workspaces ws ON ws.session_id = s.id JOIN worktrees w ON w.id = ws.worktree_id WHERE s.archived_at IS NULL ORDER BY s.updated_at DESC LIMIT 12";
const GIT_TIMEOUT_MS = 60000;

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
}

const file = (d) => path.join(d.state, FILE);

export function readReadings(d, now = d.now()) {
  try {
    return fs.readFileSync(file(d), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => now - r.at <= KEEP_MS);
  } catch { return []; }
}

function record(d, reading, now) {
  try {
    const kept = [...readReadings(d, now), reading];
    fs.mkdirSync(d.state, { recursive: true });
    fs.writeFileSync(file(d), `${kept.map((r) => JSON.stringify(r)).join('\n')}\n`);
  } catch { /* a record, not a gate */ }
}

// One reading. A probe that fails records null for that number, never a guess; a git probe that times out records the timeout.
export async function sample(d, probes = realProbes(d)) {
  const at = d.now();
  const [load1] = probes.loadavg();
  const swapPct = await probes.swapPct().catch(() => null);
  const pressure = await probes.pressure().catch(() => null);
  const swapIns = await probes.swapIns().catch(() => null);
  const last = readReadings(d, at).at(-1);
  const secs = last ? (at - last.at) / 1000 : 0;
  const swapInsPerSec = swapIns !== null && last?.swapIns != null && secs > 0 && swapIns >= last.swapIns ? Math.round((swapIns - last.swapIns) / secs) : null;
  const dirs = (await probes.worktrees().catch(() => [])).slice(0, WORKTREES);
  const gitMs = [];
  for (const dir of dirs) { const ms = await probes.gitMs(dir).catch(() => null); if (ms !== null) gitMs.push(ms); }
  const appMs = await probes.appMs().catch(() => null);
  const reading = { at, load1: Math.round(load1 * 10) / 10, cores: probes.cores(), swapPct, pressure, swapIns, swapInsPerSec, gitMs, appMs };
  record(d, reading, at);
  return reading;
}

// The verdict over the readings kept: p95 of git and app answer times, the worst recent load, memory pressure and swap-in rate, and which targets are missed.
export function judge(readings, targets = TARGETS) {
  const git = percentile(readings.flatMap((r) => r.gitMs || []), 95);
  const app = percentile(readings.map((r) => r.appMs), 95);
  const load = percentile(readings.map((r) => r.load1), 95);
  const swap = percentile(readings.map((r) => r.swapPct), 95);
  const pressure = percentile(readings.map((r) => r.pressure), 95);
  const swapIns = percentile(readings.map((r) => r.swapInsPerSec), 95);
  const misses = [];
  if (app !== null && app >= targets.appMs) misses.push(`the app answers in ${app} ms at p95, over ${targets.appMs} ms`);
  if (git !== null && git >= targets.gitMs) misses.push(`git answers in ${git} ms at p95, over ${targets.gitMs} ms`);
  if (pressure !== null && pressure >= targets.pressure) misses.push('memory pressure is critical at p95');
  if (swapIns !== null && swapIns >= targets.swapInsPerSec) misses.push(`${swapIns} pages a second are swapped in at p95, over ${targets.swapInsPerSec}`);
  return { samples: readings.length, appP95Ms: app, gitP95Ms: git, loadP95: load, pressureP95: pressure, swapInsP95PerSec: swapIns, swapP95Pct: swap, ok: misses.length === 0 && readings.length > 0, misses };
}

export function render(v) {
  if (!v.samples) return 'responsiveness: no readings yet';
  const show = (x, unit) => (x === null ? 'unknown' : `${x}${unit}`);
  return [
    `responsiveness: ${v.ok ? 'on target' : 'OVER TARGET'} (${v.samples} readings, p95)`,
    `  app answers  ${show(v.appP95Ms, ' ms')}  (target under ${TARGETS.appMs} ms)`,
    `  git          ${show(v.gitP95Ms, ' ms')}  (target under ${TARGETS.gitMs} ms)`,
    `  load average ${show(v.loadP95, '')}`,
    `  memory       ${show(v.pressureP95, '')}  (pressure level, 1 normal, 2 warning, 4 critical; target below ${TARGETS.pressure})`,
    `  swap-ins     ${show(v.swapInsP95PerSec, ' pages/s')}  (target under ${TARGETS.swapInsPerSec})`,
    `  swap used    ${show(v.swapP95Pct, '%')}  (for the record, not a bar)`,
    ...v.misses.map((m) => `  miss: ${m}`),
  ].join('\n');
}

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: GIT_TIMEOUT_MS, ...opts }, (e, out) => (e ? reject(e) : resolve(String(out)))));

export function realProbes(d) {
  return {
    loadavg: () => os.loadavg(),
    cores: () => os.cpus().length,
    swapPct: async () => {
      const m = /total = ([\d.]+)M\s+used = ([\d.]+)M/.exec(await run('/usr/sbin/sysctl', ['-n', 'vm.swapusage']));
      return m && Number(m[1]) > 0 ? Math.round((Number(m[2]) / Number(m[1])) * 100) : null;
    },
    pressure: async () => Number((await run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])).trim()),
    swapIns: async () => Number(/Swapins:\s+(\d+)/.exec(await run('/usr/bin/vm_stat', []))?.[1] ?? NaN),
    worktrees: async () => (await d.sql(WORKTREE_SQL)).map((r) => r.path).filter((p) => p && fs.existsSync(p)),
    gitMs: async (dir) => {
      const t = process.hrtime.bigint();
      try { await run('/usr/bin/git', ['-C', dir, 'rev-parse', 'HEAD']); } catch (e) { if (!e.killed) throw e; }
      return Math.round(Number(process.hrtime.bigint() - t) / 1e6);
    },
    appMs: async () => {
      const t = process.hrtime.bigint();
      const up = await appReady(d);
      return up ? Math.round(Number(process.hrtime.bigint() - t) / 1e6) : null;
    },
  };
}
