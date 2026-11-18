// Wake runners: a command the watch runs on a cadence, whose wakes are delivered to the GitHub Copilot app's sessions. The
// command watches whatever it likes and prints one JSON value:
//
//   { "wakes": [{ "session", "message", "done", "replaces" }], "status": ["…"] }
//
// Each wake's message goes to its session (`session` is optional when the runner names one). `done` is an argv that reports
// the wake's delivery: it runs after a successful send, and with `--error <reason>` added after a failed one, so the command
// can keep the wake pending until it lands. `status` lines show under `shepherd wakes`.
//
// A wake is delivered "immediate" by default: the app admits it at the session's next turn boundary. A session that works for
// hours in one run never goes idle, so a runner can ask for "enqueue" when a wake should never interrupt.
//
// The app holds an accepted message in its own queue until the session reaches a turn boundary, and it cannot be taken back.
// So a session gets one wake at a time: while the last wake sent to it has not shown up in its log, the next wake is held and
// reported undelivered, and the command, which re-derives its state every run, offers it again. A wake still missing after
// WAKE_HOLD_MS is taken as lost.
//
// A wake may name `replaces`, a message prefix. Before it is sent, the messages the session still holds in the app's queue
// that start with it (and come from the user side, never another session's or an agent's) are taken back, so a newer wake
// replaces older undelivered ones instead of queueing behind them.
//
// Nothing runs unless ~/.config/shepherd/wakes.json (or SHEPHERD_WAKES_CONFIG) says "enabled": true. Each runner's command
// runs at most every everySeconds (300 by default), and the watch's 60-second pass checks which ones are due. Its state is
// <state>/wake-runners.json. A command gets WAKE_TIMEOUT_MS to print its wakes.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShepherdError } from './error.mjs';
import { sendTo } from './socket.mjs';
import { followSession } from './operate.mjs';
import { rows } from './rows.mjs';
import { readJson, writeJson } from './store.mjs';

export const WAKE_DEFAULT_SECONDS = 300;
export const WAKE_TIMEOUT_MS = 2 * 60000;
export const WAKE_HOLD_MS = 30 * 60000;
export const WAKE_SEND_MS = 120000;
const MAX_STATUS_LINES = 20;
const MAX_LINE = 300;
const MAX_OUTPUT = 10 * 1024 * 1024;
const PROBE_CHARS = 160;
const CLOCK_SLACK_MS = 60000;
const MINUTE = 60000;

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const squash = (text) => text.replace(/\s+/g, ' ').trim();

export const wakesFile = (env = process.env, home = os.homedir()) => env.SHEPHERD_WAKES_CONFIG || path.join(home, '.config', 'shepherd', 'wakes.json');
export const wakeStateFile = (stateDir) => path.join(stateDir, 'wake-runners.json');

// The wake runners from wakes.json: { enabled, runners }, each runner { name, command, everySeconds, delivery, session? }.
// No file: off, with no runners. A file that is not valid is an error.
export function wakesConfig(file = wakesFile()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { enabled: false, runners: [] };
    throw new ShepherdError({ code: 'wakes-config', problem: `${file} could not be read (${e.message})`, fix: 'check the file, or delete it to turn wakes off' });
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new ShepherdError({ code: 'wakes-config', problem: `${file} is not valid JSON (${e.message})`, fix: 'fix the file, or delete it to turn wakes off' });
  }
  return { enabled: obj?.enabled === true, runners: runnersOf(obj?.runners, file) };
}

function runnersOf(list, file) {
  const bad = (what) => new ShepherdError({ code: 'wakes-config', problem: `${file}: ${what}`, fix: 'fix the runners in the file, or delete it to turn wakes off' });
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw bad('runners must be an array');
  const names = new Set();
  return list.map((entry, i) => {
    const r = isRecord(entry) ? entry : {};
    if (typeof r.name !== 'string' || !r.name.trim()) throw bad(`runners[${i}].name must be a non-empty name`);
    if (!Array.isArray(r.command) || r.command.length === 0 || r.command.some((part) => typeof part !== 'string' || !part)) throw bad(`runners[${i}].command must be a non-empty array of strings`);
    if (r.everySeconds !== undefined && (!Number.isInteger(r.everySeconds) || r.everySeconds < 10)) throw bad(`runners[${i}].everySeconds must be a whole number of seconds, 10 or more`);
    if (r.session !== undefined && (typeof r.session !== 'string' || !r.session.trim())) throw bad(`runners[${i}].session must be a Copilot app session id`);
    if (r.delivery !== undefined && r.delivery !== 'immediate' && r.delivery !== 'enqueue') throw bad(`runners[${i}].delivery must be "immediate" or "enqueue"`);
    const name = r.name.trim();
    if (names.has(name)) throw bad(`runners[${i}].name ${name} is listed twice`);
    names.add(name);
    return {
      name,
      command: r.command,
      everySeconds: r.everySeconds ?? WAKE_DEFAULT_SECONDS,
      delivery: r.delivery ?? 'immediate',
      ...(r.session !== undefined ? { session: r.session.trim() } : {}),
    };
  });
}

// The command's output as wakes and status lines, or the reason it is not one.
export function parseWakeOutput(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('the command did not print JSON');
  }
  const record = isRecord(parsed) ? parsed : {};
  if (!Array.isArray(record.wakes)) throw new Error('the command printed no "wakes" array');
  const wakes = record.wakes.map((entry, index) => {
    const wake = isRecord(entry) ? entry : {};
    if (typeof wake.message !== 'string' || !wake.message.trim()) throw new Error(`wakes[${index}] has no message`);
    if (wake.session !== undefined && (typeof wake.session !== 'string' || !wake.session.trim())) throw new Error(`wakes[${index}].session is not a session id`);
    if (wake.done !== undefined && (!Array.isArray(wake.done) || wake.done.length === 0 || wake.done.some((part) => typeof part !== 'string'))) throw new Error(`wakes[${index}].done is not an argv`);
    if (wake.replaces !== undefined && (typeof wake.replaces !== 'string' || !wake.replaces.trim())) throw new Error(`wakes[${index}].replaces is not a message prefix`);
    return {
      message: wake.message,
      ...(wake.session !== undefined ? { session: wake.session } : {}),
      ...(wake.done !== undefined ? { done: wake.done } : {}),
      ...(wake.replaces !== undefined ? { replaces: wake.replaces } : {}),
    };
  });
  const clean = (line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, MAX_LINE);
  const status = Array.isArray(record.status)
    ? record.status.filter((line) => typeof line === 'string').map(clean).filter(Boolean).slice(0, MAX_STATUS_LINES)
    : [];
  return { wakes, status };
}

// Runs an argv with no shell, returning what it printed. A non-zero exit, a timeout or a missing program is a failure with its reason.
export const runCommand = (argv, timeoutMs) => new Promise((resolve) => {
  const [program, ...args] = argv;
  execFile(program, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT, env: process.env }, (error, stdout, stderr) => {
    if (!error) return resolve({ ok: true, stdout, error: null });
    const reason = String(stderr).trim().split('\n')[0] || error.message;
    resolve({ ok: false, stdout, error: `${path.basename(program)} failed: ${reason}`.slice(0, MAX_LINE) });
  });
});

// One request on the app's socket and the reply to it (the last frame, which is the request's own or a socket error).
async function request(d, frame) {
  const requestId = randomUUID();
  const got = await d.exchange([{ ...frame, request_id: requestId }], {
    keep: (j) => j.request_id === requestId || j.type === 'socket_error',
    done: (j) => j.request_id === requestId || j.type === 'socket_error',
    waitMs: WAKE_SEND_MS,
  });
  return { requestId, last: got.at(-1) };
}

// Takes back the user-side messages a session still holds in its queue that start with prefix. Another session's or an agent's
// messages stay. Returns how many it removed.
export async function withdrawQueued(d, id, prefix) {
  const { last } = await request(d, { type: 'get_session_queue', session_id: id });
  const items = Array.isArray(last?.data?.items) ? last.data.items : [];
  const mine = items.filter((item) => isRecord(item) && item.kind === 'message' && typeof item.id === 'string' && item.source === 'user' && typeof item.display_text === 'string' && item.display_text.startsWith(prefix));
  let removed = 0;
  for (const item of mine) {
    const reply = await request(d, { type: 'remove_session_queue_item', session_id: id, id: item.id });
    if (reply.last?.request_id === reply.requestId && !reply.last.error) removed += 1;
  }
  return removed;
}

// Whether a message sent at sinceMs has reached the session: its log holds a user message that starts with the same text. A
// message the app still holds in its own queue is not in the log yet.
export function wakeDelivered(d, id, text, sinceMs) {
  const probe = squash(text).slice(0, PROBE_CHARS);
  return d.history(id).lines.some((line) => {
    let event;
    try {
      event = line.startsWith('{') ? JSON.parse(line) : null;
    } catch {
      return false;
    }
    if (!isRecord(event)) return false;
    const content = isRecord(event.data) && typeof event.data.content === 'string' ? event.data.content : '';
    return event.type === 'user.message' && Date.parse(event.timestamp) >= sinceMs - CLOCK_SLACK_MS && squash(content).includes(probe);
  });
}

// Sends one wake. A wake that names what it replaces takes the older queued ones back first, and still goes out when that fails.
export const wakeSender = (d) => async (session, message, delivery, replaces) => {
  // A wake aimed at a session that was handed off goes to its live successor; any trouble finding one sends to the id as named.
  const found = await rows(d).then((listed) => followSession(d, listed, session)).catch(() => null);
  const target = found?.from ? found.row.id : session;
  if (replaces) await withdrawQueued(d, target, replaces).catch(() => 0);
  const sent = await sendTo(d, target, message, WAKE_SEND_MS, delivery);
  if (sent.ok) return { ok: true, error: null, ...(found?.from ? { note: found.note } : {}) };
  return { ok: false, error: sent.error ?? (sent.reply === 'no reply' ? 'the app did not answer in time' : `the app answered ${sent.reply}, not that it took the message`) };
};

// The deps a runner uses, over the app: the command runner, the sender, the delivery check, and the clock.
export const runnerDeps = (d, now) => ({
  run: runCommand,
  send: wakeSender(d),
  delivered: (session, message, sinceMs) => wakeDelivered(d, session, message, sinceMs),
  now,
});

const ageLabel = (ms) => `${Math.max(1, Math.round(ms / MINUTE))} min`;
const ago = (iso, now) => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / MINUTE));
  return minutes < 1 ? 'just now' : minutes < 90 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
};

// The wakes sent earlier that are still in the app's queue, by session: the ones the session's log does not show and that are
// younger than the hold.
function openWakes(previous, deps) {
  return Object.fromEntries(Object.entries(previous.open ?? {}).filter(([session, wake]) => {
    const sentAt = Date.parse(wake.at);
    return deps.now - sentAt < WAKE_HOLD_MS && !deps.delivered(session, wake.message, sentAt);
  }));
}

function fail(state, reason) {
  state.lastError = reason;
  return state;
}

// Runs one runner's command, delivers its wakes and reports each one back. Returns the runner's new state.
export async function runWakeRunner(runner, deps, previous = {}) {
  const state = { lastRunAt: new Date(deps.now).toISOString() };
  const open = openWakes(previous, deps);
  if (Object.keys(open).length) state.open = open;
  const ran = await deps.run(runner.command, WAKE_TIMEOUT_MS);
  if (!ran.ok) return fail(state, ran.error ?? 'the command failed');
  let output;
  try {
    output = parseWakeOutput(ran.stdout);
  } catch (error) {
    return fail(state, error.message);
  }
  state.status = output.status;
  state.lastWakes = output.wakes.length;
  state.lastDelivered = 0;
  const problems = [];
  for (const wake of output.wakes) {
    const session = wake.session ?? runner.session;
    // A wake that replaces older ones takes them back from the app's queue and goes out; only a wake that cannot is held behind the last one.
    const holding = session && !wake.replaces ? state.open?.[session] : undefined;
    const sent = !session
      ? { ok: false, error: 'the wake names no session and the runner has none' }
      : holding
        ? { ok: false, error: `held: the wake sent ${ageLabel(deps.now - Date.parse(holding.at))} ago has not reached the session yet` }
        : await deps.send(session, wake.message, runner.delivery ?? 'immediate', wake.replaces).catch((error) => ({ ok: false, error: error.message }));
    if (session && sent.ok) (state.open ??= {})[session] = { at: new Date(deps.now).toISOString(), message: wake.message };
    const reason = sent.ok ? null : sent.error ?? 'the app refused the message';
    if (!reason) state.lastDelivered += 1;
    else problems.push(`could not deliver a wake: ${reason}`);
    if (wake.done) {
      const reported = await deps.run(reason === null ? wake.done : [...wake.done, '--error', reason], WAKE_TIMEOUT_MS);
      if (!reported.ok) problems.push(`could not report a wake's delivery: ${reported.error ?? 'the command failed'}`);
    }
  }
  if (problems.length) state.lastError = problems[0];
  return state;
}

// Runs the runners named in `only` (all by default) at the same time, so a slow one never holds up the rest, and writes their states.
// Each state goes into the file as it is when the runner ends, so runners that finish at different times keep each other's states.
// A runner dropped from the config loses its state.
export async function runWakeRunners(stateDir, runners, deps, only) {
  const file = wakeStateFile(stateDir);
  const before = readJson(file, {});
  const chosen = runners.filter((runner) => !only || only.has(runner.name));
  const ended = new Map();
  if (!chosen.length) writeJson(file, Object.fromEntries(runners.map((r) => [r.name, before[r.name] ?? {}])));
  await Promise.all(chosen.map(async (runner) => {
    const state = await runWakeRunner(runner, deps, before[runner.name]);
    ended.set(runner.name, state);
    const stored = readJson(file, {});
    writeJson(file, Object.fromEntries(runners.map((r) => [r.name, ended.get(r.name) ?? stored[r.name] ?? {}])));
  }));
  return Object.fromEntries(runners.map((runner) => [runner.name, ended.get(runner.name) ?? before[runner.name] ?? {}]));
}

export const WAKE_PASS_WAIT_MS = 20000;
const inflight = new WeakMap();

// The watch's pass: starts the runners that are due, each at its own everySeconds, at the same time, and returns the states of those
// that finished within WAKE_PASS_WAIT_MS. A runner still going then carries on in the background and is not started again until it ends,
// so a runner that takes minutes (a wake to a session that loads slowly) never delays the others' next poll.
// `due` remembers each runner's next run between passes.
export async function runDueWakes(d, runners, due, now = d.now(), waitMs = WAKE_PASS_WAIT_MS) {
  const busy = inflight.get(due) ?? inflight.set(due, new Set()).get(due);
  const ready = new Set(runners.filter((runner) => (due.get(runner.name) ?? 0) <= now && !busy.has(runner.name)).map((runner) => runner.name));
  const ran = {};
  const runs = [...ready].map((name) => {
    busy.add(name);
    return runWakeRunners(d.state, runners, runnerDeps(d, now), new Set([name]))
      .then((states) => { ran[name] = states[name]; })
      .catch(() => {})
      .finally(() => busy.delete(name));
  });
  let timer;
  if (runs.length) await Promise.race([Promise.all(runs), new Promise((resolve) => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
  for (const runner of runners) if (ready.has(runner.name)) due.set(runner.name, now + runner.everySeconds * 1000);
  for (const name of [...due.keys()]) if (!runners.some((runner) => runner.name === name)) due.delete(name);
  return ran;
}

// What each runner would deliver now, with nothing sent or reported: `shepherd wakes poll` when wakes.json is off.
export async function planWakes(runners, run = runCommand) {
  const plans = [];
  for (const runner of runners) {
    const ran = await run(runner.command, WAKE_TIMEOUT_MS);
    if (!ran.ok) {
      plans.push({ name: runner.name, error: ran.error ?? 'the command failed', wakes: [], status: [] });
      continue;
    }
    try {
      const out = parseWakeOutput(ran.stdout);
      plans.push({ name: runner.name, error: null, status: out.status, wakes: out.wakes.map((wake) => ({ session: wake.session ?? runner.session ?? null, message: wake.message, replaces: wake.replaces ?? null })) });
    } catch (error) {
      plans.push({ name: runner.name, error: error.message, wakes: [], status: [] });
    }
  }
  return plans;
}

// One `shepherd wakes` line per runner (last run, wakes delivered, open wakes, last error), then the lines its command reported.
export function wakeStatusLines(runners, states, now) {
  return runners.flatMap((runner) => {
    const state = states[runner.name];
    if (!state?.lastRunAt) return [`wake runner ${runner.name}: not run yet`];
    const delivered = state.lastWakes === undefined ? '' : `, ${state.lastDelivered}/${state.lastWakes} wake${state.lastWakes === 1 ? '' : 's'} delivered`;
    const open = Object.keys(state.open ?? {}).length;
    const openLabel = open ? `, ${open} open` : '';
    return [`wake runner ${runner.name}: ran ${ago(state.lastRunAt, now)}${delivered}${openLabel}${state.lastError ? `, last error: ${state.lastError}` : ''}`, ...(state.status ?? [])];
  });
}

export const readWakeStates = (stateDir) => readJson(wakeStateFile(stateDir), {});
