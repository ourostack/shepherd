// Where a lane should run: the cloud, the mini (this Mac), or the laptop, from what each can take right now. The mini is
// memory-bound, so a lane that does not need it goes to the cloud, and one that does goes to the laptop while the mini is
// loaded. Inputs are counts and times only: the mini's swap and load, the laptop's heartbeat age, and the cloud 403 windows
// recorded with `shepherd place cloud-blocked`. `report` counts where the last days' lanes ran and whether the local ones needed to.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { realProbes } from './responsiveness.mjs';

export const LIMITS = { swapPct: 90, loadPerCore: 1.5, staleIntervals: 2, defaultIntervalSec: 600, blockMinutes: 60, minDiskGb: 10 };
export const PLACES = ['cloud', 'mini', 'laptop'];
const BLOCKS = 'cloud-blocks.json';
const LOG = 'place-log.jsonl';
const CONFIG = 'place.json';
const HISTORY_READ_BYTES = 40e6;

// Commands and files only the mini has: a lane that touches one of these was right to run here.
const MINI_MARKERS = [/launchctl/, /data\.db/, /Library\/(Caches|LaunchAgents)/, /\bhousesitter (deploy|restart|status|doctor)/, /\bshepherd (sessions|retire|watch|status|quota|open|message|wakes|stuck|trust|sidebar)/, /\.local\/agency/, /npm (i|install) -g/, /\bsqlite3\b/];

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const at = (d, name) => path.join(d.state, name);
const mins = (ms) => Math.round(ms / 60000);

// The 403 windows still open at `now`: { until, repo } where repo is null for a block on all repositories.
export function cloudBlocks(d, now = d.now()) {
  return readJson(at(d, BLOCKS), []).filter((b) => Number.isFinite(b.until) && b.until > now);
}

export function blockCloud(d, { repo = null, minutes = LIMITS.blockMinutes } = {}) {
  const now = d.now();
  const kept = cloudBlocks(d, now).filter((b) => (b.repo ?? null) !== repo);
  const block = { until: now + minutes * 60000, repo };
  fs.mkdirSync(d.state, { recursive: true });
  fs.writeFileSync(at(d, BLOCKS), `${JSON.stringify([...kept, block])}\n`);
  return block;
}

export function clearCloud(d, { repo = null } = {}) {
  const kept = cloudBlocks(d).filter((b) => repo !== null && (b.repo ?? null) !== repo);
  fs.mkdirSync(d.state, { recursive: true });
  fs.writeFileSync(at(d, BLOCKS), `${JSON.stringify(kept)}\n`);
  return kept;
}

export function cloudState(d, repo, now = d.now()) {
  const hit = cloudBlocks(d, now).filter((b) => b.repo === null || b.repo === repo).sort((a, b) => b.until - a.until)[0];
  return hit ? { blocked: true, until: hit.until, minutesLeft: mins(hit.until - now) } : { blocked: false };
}

export function miniState({ swapPct = null, load1 = null, cores = 1 } = {}) {
  const why = [];
  if (swapPct !== null && swapPct >= LIMITS.swapPct) why.push(`swap ${swapPct}% full`);
  if (load1 !== null && load1 / cores >= LIMITS.loadPerCore) why.push(`load ${load1} on ${cores} cores`);
  return { swapPct, load1, cores, loaded: why.length > 0, why: why.join(', ') };
}

// The laptop's heartbeat (when it wrote it, how often, whether its hub is connected, its free disk) as a verdict.
export function laptopState(beat, now) {
  if (!beat) return { ready: false, why: 'no laptop heartbeat' };
  const written = Date.parse(beat.at);
  if (!Number.isFinite(written)) return { ready: false, why: 'the laptop heartbeat has no time' };
  const limit = (beat.interval_sec || LIMITS.defaultIntervalSec) * LIMITS.staleIntervals * 1000;
  const age = now - written;
  if (age > limit) return { ready: false, why: `the laptop heartbeat is ${mins(age)} min old`, ageMin: mins(age) };
  if (beat.hub?.connected === false) return { ready: false, why: 'the laptop is up but its hub is not connected', ageMin: mins(age) };
  if (beat.disk?.free_gb != null && beat.disk.free_gb < LIMITS.minDiskGb) return { ready: false, why: `the laptop has ${beat.disk.free_gb} GB free`, ageMin: mins(age) };
  return { ready: true, why: `laptop heartbeat ${mins(age)} min old`, ageMin: mins(age) };
}

// The answer: one place and a one-line reason. `local` is a lane that needs local tools or state; `miniOnly` needs state only the mini has.
export function decide({ local = false, miniOnly = false, mini, laptop, cloud }) {
  const done = (place, why) => ({ place, why });
  if (miniOnly) return done('mini', mini.loaded ? `it needs state only the mini has; the mini is loaded (${mini.why}), so hold other lanes if you can` : 'it needs state only the mini has');
  const parts = [];
  if (!local) {
    if (!cloud.blocked) return done('cloud', 'it needs nothing local, and cloud is the default');
    parts.push(`cloud is blocked for ${cloud.minutesLeft} more min (403)`);
  }
  if (!mini.loaded) return done('mini', [...parts, local ? 'it needs local tools and the mini has room' : 'the mini has room'].join('; '));
  if (laptop.ready) return done('laptop', [...parts, `the mini is loaded (${mini.why})`, laptop.why].join('; '));
  return done('mini', [...parts, `the mini is loaded (${mini.why}) and ${laptop.why}: the mini is the only host up, so hold other lanes if you can`].join('; '));
}

// The laptop heartbeat the config names: { laptop: { gist, file, gh } }, read through the gh CLI. Null when unset or unreadable.
export function laptopBeat(d) {
  const cfg = readJson(at(d, CONFIG), {}).laptop;
  if (!cfg?.gist) return Promise.resolve(null);
  return new Promise((resolve) => execFile(cfg.gh || 'gh', ['gist', 'view', cfg.gist, '-f', cfg.file || 'laptop.json'], { timeout: 20000 }, (err, out) => {
    try { resolve(err ? null : JSON.parse(String(out))); } catch { resolve(null); }
  }));
}

export function liveProbes(d) {
  const base = realProbes(d);
  return { loadavg: base.loadavg, cores: base.cores, swapPct: () => base.swapPct().catch(() => null), laptop: () => laptopBeat(d) };
}

export async function place(d, { repo = null, local = false, miniOnly = false } = {}, probes = liveProbes(d)) {
  const now = d.now();
  const [load1] = probes.loadavg();
  const mini = miniState({ swapPct: await probes.swapPct(), load1: Math.round(load1 * 10) / 10, cores: probes.cores() });
  const laptop = laptopState(await probes.laptop(), now);
  const cloud = cloudState(d, repo, now);
  const answer = decide({ local, miniOnly, mini, laptop, cloud });
  const result = { ...answer, repo, local, miniOnly, mini, laptop, cloud };
  try {
    fs.mkdirSync(d.state, { recursive: true });
    fs.appendFileSync(at(d, LOG), `${JSON.stringify({ at: now, repo, local, miniOnly, place: answer.place, why: answer.why })}\n`);
  } catch { /* a record, not a gate */ }
  return result;
}

export function placements(d, days = 7, now = d.now()) {
  const rows = [];
  try { for (const l of fs.readFileSync(at(d, LOG), 'utf8').split('\n').filter(Boolean)) rows.push(JSON.parse(l)); } catch { /* none yet */ }
  const recent = rows.filter((r) => now - r.at <= days * 86400000);
  const by = {};
  for (const r of recent) by[r.place] = (by[r.place] || 0) + 1;
  return by;
}

// The tool calls at the start of a lane's history, joined: the only place a mini-only command can show.
function toolCalls(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, HISTORY_READ_BYTES));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8').split('\n').filter((l) => l.includes('"tool.execution_start"')).join('\n');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

export const LANES = `SELECT s.id, s.execution_location AS loc, json_extract(re.kind_json, '$.envKind') AS env, coalesce(c.title, '(unnamed)') AS coord
FROM sessions s JOIN workspaces w ON w.session_id = s.id LEFT JOIN sessions c ON c.id = w.creator_session_id
LEFT JOIN remote_environments re ON re.id = CASE WHEN s.execution_location LIKE '{%' THEN json_extract(s.execution_location, '$.host_id') END
WHERE w.creator_session_id IS NOT NULL AND s.created_at > datetime('now', '-DAYS days')`;

// Where the last `days` days' lanes (sessions a coordinator started) ran, by coordinator; for the local ones, whether their
// tool calls show something only the mini has (needed) or nothing (could have run in the cloud), or there is no history to read.
export async function report(d, { days = 7 } = {}) {
  const lanes = await d.sql(LANES.replace('-DAYS', `-${Number(days)}`));
  const total = { lanes: lanes.length, cloud: 0, mini: 0, remote: 0, neededLocal: 0, couldCloud: 0, noHistory: 0 };
  const by = new Map();
  for (const l of lanes) {
    const c = by.get(l.coord) ?? { coordinator: l.coord, cloud: 0, mini: 0, remote: 0, neededLocal: 0, couldCloud: 0, noHistory: 0 };
    by.set(l.coord, c);
    const where = l.loc === 'local' || !l.loc ? 'mini' : l.env === 'managed-sandbox' ? 'cloud' : 'remote';
    c[where]++; total[where]++;
    if (where !== 'mini') continue;
    const calls = toolCalls(d.historyPath(l.id));
    const kind = calls === null ? 'noHistory' : MINI_MARKERS.some((r) => r.test(calls)) ? 'neededLocal' : 'couldCloud';
    c[kind]++; total[kind]++;
  }
  return { days, ...total, byCoordinator: [...by.values()].sort((a, b) => b.cloud + b.mini + b.remote - (a.cloud + a.mini + a.remote)), placements: placements(d, days) };
}

export function renderPlace(r) {
  const l = r.laptop.ready ? 'ready' : 'not ready';
  return `${r.place}: ${r.why}\n  mini: ${r.mini.swapPct ?? '?'}% swap, load ${r.mini.load1 ?? '?'}/${r.mini.cores} cores; laptop: ${l}; cloud: ${r.cloud.blocked ? `blocked ${r.cloud.minutesLeft} more min` : 'open'}`;
}

export function renderReport(r) {
  const head = `last ${r.days} days: ${r.lanes} lanes: ${r.cloud} cloud, ${r.mini} local on the mini, ${r.remote} on another host`;
  const mini = `local lanes: ${r.neededLocal} touched something only the mini has, ${r.couldCloud} did not (could have run in the cloud), ${r.noHistory} have no history to read`;
  const rows = r.byCoordinator.map((c) => `  ${c.coordinator.slice(0, 40)}: ${c.cloud} cloud, ${c.mini} mini (${c.neededLocal} needed, ${c.couldCloud} could-cloud, ${c.noHistory} no history), ${c.remote} other`);
  const asked = Object.entries(r.placements).map(([p, n]) => `${n} ${p}`).join(', ');
  return [head, mini, ...rows, `place answers: ${asked || 'none recorded yet'}`].join('\n');
}
