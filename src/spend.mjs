// `shepherd spend`: which model each session ran on, per coordinator and lane, from the sessions' own histories. Zero tokens.
// A history records each model call as a session.usage_record (model, cost = premium-request weight, isAuto) and each model
// choice as a session.model_change (newModel, source). A turn is an assistant.turn_start, given the model of the first reply
// that follows it. Only events inside the window count; a lane's model choice is read from the whole history.
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { coordinatorOf, handoffSuccessors } from './coordinator.mjs';
import { rows } from './rows.mjs';

export const DAYS = 7;
export const EXPENSIVE_SHARE = 0.5;
export const MIN_LANE_TURNS = 10;
const DAY_MS = 24 * 3600000;

export const tierOf = (model) => (/opus/i.test(model) ? 'expensive' : /sonnet|haiku|mini|flash|nano|lite/i.test(model) ? 'cheap' : 'other');
const blank = () => ({ turns: 0, calls: 0, weight: 0, byModel: {} });
const bump = (w, model, { turns = 0, calls = 0, weight = 0 }) => {
  const m = (w.byModel[model] ??= { turns: 0, calls: 0, weight: 0 });
  for (const t of [w, m]) { t.turns += turns; t.calls += calls; t.weight = Math.round((t.weight + weight) * 1000) / 1000; }
};

// The history file's lines, plain or gzipped (an archived session keeps events.jsonl.gz). Missing: none.
function lineStream(file) {
  if (fs.existsSync(file)) return readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  if (fs.existsSync(`${file}.gz`)) return readline.createInterface({ input: fs.createReadStream(`${file}.gz`).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  return null;
}

// One session's spend: { week, today } windows (turns, calls, weight, byModel), and whether its model was explicit.
export async function readSession(file, { since, dayStart, now }) {
  const out = { week: blank(), today: blank(), changes: [], auto: false, used: false };
  const stream = lineStream(file);
  if (!stream) return out;
  let pendingTurn = null;
  const count = (at, model, part) => { if (at >= since && at <= now) bump(out.week, model, part); if (at >= dayStart && at <= now) bump(out.today, model, part); };
  for await (const line of stream) {
    if (!line.includes('"session.usage_record"') && !line.includes('"session.model_change"') && !line.includes('"assistant.turn_start"') && !line.includes('"assistant.message"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const at = Date.parse(e?.timestamp);
    const data = e?.data ?? {};
    if (e.type === 'session.model_change') out.changes.push({ model: data.newModel ?? null, source: data.source ?? null });
    else if (e.type === 'assistant.turn_start' && e.agentId === undefined) pendingTurn = at;
    else if (e.type === 'assistant.message' && e.agentId === undefined && pendingTurn !== null && typeof data.model === 'string') {
      count(pendingTurn, data.model, { turns: 1 });
      pendingTurn = null;
    } else if (e.type === 'session.usage_record' && data.usage && typeof data.usage.model === 'string') {
      const u = data.usage;
      if (at >= since && at <= now) { out.used = true; if (u.isAuto === true) out.auto = true; }
      count(at, u.model, { calls: 1, weight: Number(u.cost) || 0 });
    }
  }
  return out;
}

// Explicit means a model choice is on record, and it was not made by auto-selection.
const explicit = (r) => !r.auto && r.changes.some((c) => c.model && !/auto/i.test(String(c.source)) && !/^auto$/i.test(c.model));

function shares(w) {
  const t = { cheap: 0, expensive: 0, other: 0 };
  for (const [model, m] of Object.entries(w.byModel)) t[tierOf(model)] += m.turns;
  const total = t.cheap + t.expensive + t.other;
  return { cheapTurns: t.cheap, expensiveTurns: t.expensive, otherTurns: t.other, cheapShare: total ? t.cheap / total : null, expensiveShare: total ? t.expensive / total : null };
}

function sum(list, pick) {
  const w = blank();
  for (const s of list) {
    const from = pick(s);
    for (const [model, m] of Object.entries(from.byModel)) bump(w, model, m);
  }
  return w;
}

const windowOf = (w) => ({ turns: w.turns, calls: w.calls, weight: w.weight, ...shares(w), byModel: w.byModel });

// The whole report. `d` is Shepherd's deps (the sidebar over the socket, the histories by path).
export async function spend(d, { days = DAYS, now = d.now() } = {}) {
  const since = now - days * DAY_MS;
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const listed = await rows(d, now, { archived: true });
  const successor = handoffSuccessors(d);
  const bound = listed.map((row) => ({ row, coord: coordinatorOf(row, listed, { d, successorOf: successor }) }));
  const coordinatorIds = new Set(bound.map((b) => b.coord?.id).filter(Boolean));
  const sessions = [];
  for (const { row, coord } of bound) {
    const r = await readSession(d.historyPath(row.id), { since, dayStart, now });
    if (r.week.turns === 0 && r.week.calls === 0) continue;
    const role = coordinatorIds.has(row.id) ? 'coordinator' : coord ? 'lane' : 'other';
    sessions.push({
      id: row.id, name: row.name, role, archived: row.archived === true, coordinatorId: coord?.id ?? null, coordinator: coord?.id ? coord.name : coord?.gone ? '(gone)' : null,
      explicit: explicit(r), models: Object.keys(r.week.byModel), week: windowOf(r.week), today: windowOf(r.today),
    });
  }
  const groups = new Map();
  for (const s of sessions.filter((x) => x.role === 'lane')) {
    const key = s.coordinatorId ?? '(gone)';
    if (!groups.has(key)) groups.set(key, { id: key, name: s.coordinator, lanes: [] });
    groups.get(key).lanes.push(s);
  }
  const coordinators = [...groups.values()].map((g) => {
    const week = windowOf(sum(g.lanes, (s) => s.week));
    const self = sessions.find((s) => s.id === g.id);
    const flagged = week.expensiveShare !== null && week.expensiveShare >= EXPENSIVE_SHARE && week.turns >= MIN_LANE_TURNS;
    return { id: g.id, name: g.name, models: self?.models ?? [], lanes: g.lanes.length, week, today: windowOf(sum(g.lanes, (s) => s.today)), flagged, noModel: g.lanes.filter((s) => !s.explicit).map((s) => s.name) };
  }).sort((a, b) => b.week.turns - a.week.turns);
  const lanes = sessions.filter((s) => s.role === 'lane');
  return {
    window: { days, since: new Date(since).toISOString(), today: new Date(dayStart).toISOString(), now: new Date(now).toISOString() },
    seen: listed.length, active: sessions.length,
    lanes: { count: lanes.length, week: windowOf(sum(lanes, (s) => s.week)), today: windowOf(sum(lanes, (s) => s.today)) },
    coordinators, flagged: coordinators.filter((c) => c.flagged).map((c) => c.name),
    noModel: sessions.filter((s) => !s.explicit).map((s) => ({ id: s.id, name: s.name, role: s.role, turns: s.week.turns })),
    sessions,
  };
}

const pct = (v) => (v === null ? '-' : `${Math.round(v * 100)}%`);
const brief = (w) => `${w.turns} turns, ${w.weight} weight, ${pct(w.cheapShare)} cheap, ${pct(w.expensiveShare)} Opus-class${w.otherTurns ? `, ${w.otherTurns} other` : ''}`;
const mix = (w) => Object.entries(w.byModel).sort((a, b) => b[1].turns - a[1].turns).map(([m, v]) => `${m} ${v.turns}`).join(', ') || 'no turns';

export function renderSpend(r) {
  const out = [`spend, last ${r.window.days} days (since ${r.window.since.slice(0, 16)}Z) and today; ${r.active} of ${r.seen} sessions active`];
  out.push(`lanes: ${r.lanes.count}; week: ${brief(r.lanes.week)}; today: ${brief(r.lanes.today)}`);
  for (const c of r.coordinators) {
    out.push('', `${c.flagged ? 'EXPENSIVE ' : ''}${c.name ?? c.id.slice(0, 8)}${c.models.length ? ` [${c.models.join(', ')}]` : ''}: ${c.lanes} lanes; week ${brief(c.week)}; today ${brief(c.today)}`);
    for (const s of r.sessions.filter((x) => x.role === 'lane' && (x.coordinatorId ?? '(gone)') === c.id).sort((a, b) => b.week.turns - a.week.turns)) {
      out.push(`  ${s.explicit ? '' : '(no explicit model) '}${s.name}${s.archived ? ' [archived]' : ''}: ${mix(s.week)}; ${s.week.weight} weight; today ${s.today.turns} turns`);
    }
  }
  if (r.flagged.length) out.push('', `Decision: ${r.flagged.join(', ')} run ${Math.round(EXPENSIVE_SHARE * 100)}% or more of their lane turns on Opus-class models; move the lanes to Sonnet or Haiku, or name the model in the lane's kickoff.`);
  if (r.noModel.length) out.push('', `No explicit model (${r.noModel.length}): ${r.noModel.map((s) => `${s.name} (${s.turns} turns)`).join('; ')}`);
  return out.join('\n');
}
