// The size watch. A session's events.jsonl is loaded whole when the app resumes it, so a history over the resume cap is never
// resumed by Shepherd: it is flagged, and its coordinator (and the session itself while it runs) is asked to hand off. Each
// time it grows by half, they are asked again, because one ask is easily ignored. A flagged session that then sits idle for
// 30 minutes (or at once, when memory runs short) is archived through the app, reversibly and keeping its worktree, and its
// coordinator is told where it left off. A session that is not running and has no smaller coordinator is never messaged,
// because the message would reload it: the owner is told instead.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { coordinatorOf, handoffSuccessors } from './coordinator.mjs';
import { readTail } from './history.mjs';
import { MAX_HISTORY_BYTES } from './sessions.mjs';
import { mb, plain } from './notice.mjs';
import { DELIVER_MS, archiveRow, readJson, sessionsRoot, statePath, writeJson } from './store.mjs';
import { sendTo } from './socket.mjs';

export const OVERSIZE_BYTES = MAX_HISTORY_BYTES;
/** A flagged session that keeps running is asked again each time its history reaches this multiple of its size at the last ask. */
export const RENUDGE_GROWTH = 1.5;
/** A flagged session idle this long after its last ask is archived. */
export const IDLE_ARCHIVE_MS = 30 * 60_000;
/** Swap use above this, or free memory below the next, means the machine is short of memory: idle giants go at once. */
export const PRESSURE_SWAP_BYTES = 8 * 1024 ** 3;
export const PRESSURE_FREE_BYTES = 1024 ** 3;
/** How far back from the end of a history to look for where the session last pushed and opened a pull request. */
const PUSH_SCAN_BYTES = 64 * 1024 * 1024;

export const readOversize = (d) => readJson(statePath(d, 'oversize'), { sessions: {} }).sessions || {};

export function handoffNudge(name, bytes, asked = 0, askedAtBytes, id = '<its session id>') {
  const again = asked ? ` This is ask ${asked + 1}${askedAtBytes ? `: it was ${mb(askedAtBytes)} at the last one and is still growing` : ''}.` : '';
  return `The session "${plain(name, 60)}" has a ${mb(bytes)} history, over the ${mb(OVERSIZE_BYTES)} limit: the app loads all of it into memory every time that session resumes, and a few like it froze this Mac.${again} Please hand it off now: write a checkpoint of its purpose and open work, then start a fresh successor session whose first message begins with the line \`Succeeds: ${id}\` and has it read that checkpoint plus the tail of the old log. That line is how the old session is retired: it is archived for you (reversibly) once the successor has taken its first turn and the old one is idle, or in any case once it has been idle ${IDLE_ARCHIVE_MS / 60_000} minutes after this ask. This goes to the session and to its coordinator; the coordinator starts the successor when there is one. Keep images out of chat (save screenshots and art as files and link the path): inline images are nearly all of the size.`;
}

export function archivedNote(name, id, bytes, where) {
  return `I archived the session "${plain(name, 60)}" (${id}) to free memory: its ${mb(bytes)} history is over the ${mb(OVERSIZE_BYTES)} limit and it sat idle after the hand-off ask. The archive is reversible from the app, and its worktree was kept. Where it left off: ${where}. If its work is not finished, start a fresh successor session from there and the tail of its log (~/.copilot/session-state/${id}/events.jsonl).`;
}

// Swap in use and free memory: `sysctl vm.swapusage` on macOS, `/proc/meminfo` elsewhere. An unreadable swap counts as none.
export function readMemory(platform = process.platform, read = (what) => (what === 'swapusage'
  ? execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 5000 })
  : fs.readFileSync('/proc/meminfo', 'utf8'))) {
  let swapUsedBytes = 0;
  try {
    if (platform === 'darwin') swapUsedBytes = Number(/used = ([\d.]+)M/.exec(read('swapusage'))?.[1] ?? 0) * 1024 ** 2;
    else {
      const info = read('meminfo');
      const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? 0) * 1024;
      swapUsedBytes = kb('SwapTotal') - kb('SwapFree');
    }
  } catch {
    swapUsedBytes = 0;
  }
  return { swapUsedBytes, freeBytes: os.freemem() };
}

export const shortOfMemory = (memory) => memory.swapUsedBytes > PRESSURE_SWAP_BYTES || memory.freeBytes < PRESSURE_FREE_BYTES;

// Every local session's history size, whether or not the sidebar lists it.
function localLogSizes(d) {
  const sizes = new Map();
  let names;
  try { names = fs.readdirSync(sessionsRoot(d)); } catch { return sizes; }
  for (const name of names) sizes.set(name, d.historySize(name));
  return sizes;
}

// The name the session saved for itself, for one the sidebar no longer lists.
function savedName(d, id) {
  try {
    const head = fs.readFileSync(path.join(sessionsRoot(d), id, 'workspace.yaml'), 'utf8').slice(0, 4096);
    return /^name: ['"]?(.*?)['"]?$/m.exec(head)?.[1] || null;
  } catch {
    return null;
  }
}

const last = (text, pattern) => text.match(pattern)?.at(-1);

// Where a session left off, for its coordinator: its branch, and the last `git push` and pull request in the end of its
// history (credentials in a push URL are cut). Only the last 64 MB is read.
export function whereItLeftOff(row, d) {
  const text = readTail(d.historyPath(row.id), PUSH_SCAN_BYTES, { keepPartial: true }).join('\n');
  const push = last(text, /git push\b[^"\\\n]{0,200}/g);
  const pr = last(text, /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g);
  const parts = [
    ...(row.branch ? [`branch ${row.branch}${row.projectRepo ? ` in ${row.projectRepo}` : ''}`] : []),
    ...(push ? [`last push \`${push.split(/\s(?:2>|\||;|&&)/)[0].replace(/\/\/[^/@\s]*@/, '//').trim()}\``] : []),
    ...(pr ? [`last pull request ${pr}`] : []),
  ];
  return parts.length ? parts.join('; ') : 'no push or pull request in the end of its history';
}

const send = (d, id, text) => (d.send ? d.send(id, text) : sendTo(d, id, text, DELIVER_MS));
const doArchive = async (d, row, reason, note) => {
  try { return (await (d.archive ? d.archive(row, reason, note) : archiveRow(d, row, reason, note))) === true; } catch { return false; }
};
const failed = (error) => ({ ok: false, error: error.message });

// Flags every over-limit session, asks for a hand-off as one grows, and archives the idle ones. apply: false computes the
// same actions and changes nothing. Each action is { what, id, name, done, why, ... }.
export async function noticeOversizedSessions(listed, d, { apply = true } = {}) {
  const at = new Date(d.now()).toISOString();
  const before = readOversize(d);
  const sizes = localLogSizes(d);
  const listedById = new Map(listed.filter((row) => !row.remote).map((row) => [row.id, row]));
  const next = {};
  for (const [id, bytes] of sizes) {
    if (bytes <= OVERSIZE_BYTES) continue;
    const { unlisted: _unlisted, ...kept } = before[id] ?? {};
    const row = listedById.get(id);
    next[id] = { ...kept, bytes, name: row?.name ?? kept.name ?? savedName(d, id) ?? id, ...(row ? {} : { unlisted: true }) };
  }
  const big = [...listedById.values()].filter((row) => next[row.id]);
  const successors = handoffSuccessors(d);
  // A coordinator that is itself a giant is only messaged while it runs, since a message would reload it.
  // The coordinator now, not the one the app recorded: that one may have handed off and been archived.
  const reachable = (lane) => {
    const found = coordinatorOf(lane, listed.filter((row) => !row.remote), { d, successorOf: successors });
    const row = found && 'id' in found ? listedById.get(found.id) : undefined;
    return row && (row.isRunning || !next[row.id]) ? row : undefined;
  };
  const actions = [];
  for (const row of big) {
    const entry = next[row.id];
    actions.push({ what: 'flag', id: row.id, name: row.name, done: apply, why: `its history is ${mb(entry.bytes)}, over the ${mb(OVERSIZE_BYTES)} resume cap` });
  }

  let nudged = 0;
  const ownerRows = [];
  for (const row of big) {
    const entry = next[row.id];
    const due = row.isRunning ? entry.nudgedBytes === undefined || entry.bytes >= entry.nudgedBytes * RENUDGE_GROWTH : !entry.nudgedAt;
    if (!due) continue;
    const boss = reachable(row);
    const to = [...(boss && boss.id !== row.id ? [boss.id] : []), ...(row.isRunning ? [row.id] : [])];
    if (!to.length) { ownerRows.push(row); continue; }
    // An entry from before asks were counted had one ask.
    const asked = entry.nudges ?? (entry.nudgedAt ? 1 : 0);
    const text = handoffNudge(row.name, entry.bytes, asked, entry.nudgedBytes, row.id);
    if (!apply) { actions.push({ what: 'ask', id: row.id, name: row.name, done: false, to, why: `asks ${to.map((id) => id.slice(0, 8)).join(', ')} to hand off` }); continue; }
    const reached = [];
    for (const id of to) if ((await send(d, id, text).catch(failed)).ok) reached.push(id);
    if (!reached.length) continue;
    Object.assign(entry, { nudgedAt: at, nudgedBytes: entry.bytes, nudges: asked + 1, to: reached.join(',') });
    nudged += 1;
    actions.push({ what: 'ask', id: row.id, name: row.name, done: true, to: reached, why: `asked ${reached.map((id) => id.slice(0, 8)).join(', ')} to hand off` });
  }

  if (ownerRows.length) {
    const lines = ownerRows.map((row) => `- "${plain(row.name, 60)}" (${mb(next[row.id].bytes)})`);
    const text = `These sessions have histories over ${mb(OVERSIZE_BYTES)} and cannot be nudged without reloading them. They need a hand-off to a fresh successor session (checkpoint, tail, archive); keep images out of chat:\n${lines.join('\n')}`;
    let told = false;
    if (apply) told = (await Promise.resolve().then(() => d.tell(text)).catch(() => ({ ok: false }))).ok === true;
    for (const row of ownerRows) {
      actions.push({ what: 'owner', id: row.id, name: row.name, done: told, why: 'no coordinator can take it: the owner is told' });
      next[row.id].to = 'owner';
      if (told) {
        Object.assign(next[row.id], { nudgedAt: at, nudgedBytes: next[row.id].bytes, nudges: (next[row.id].nudges ?? 0) + 1 });
        nudged += 1;
      }
    }
  }

  // Archive: a flagged session that is not running (nor waiting on a person) and sat idle since its last ask, or all of
  // them at once under memory pressure, largest first.
  const quiet = big.filter((row) => !row.isRunning && row.state !== 'waiting');
  const pressed = quiet.length > 0 && shortOfMemory((d.memory ?? readMemory)());
  const idle = quiet.filter((row) => {
    const entry = next[row.id];
    if (pressed) return true;
    if (!entry.nudgedAt) return false;
    return d.now() - Math.max(Date.parse(entry.nudgedAt), Date.parse(row.lastActivity ?? '') || 0) >= IDLE_ARCHIVE_MS;
  }).sort((a, b) => next[b.id].bytes - next[a.id].bytes);
  let archived = 0;
  for (const row of idle) {
    const entry = next[row.id];
    const where = whereItLeftOff(row, d);
    const reason = pressed ? 'memory-pressure' : 'oversize-idle';
    const why = `${mb(entry.bytes)}; ${where}`;
    if (!apply) { actions.push({ what: 'archive', id: row.id, name: row.name, reason, done: false, why }); continue; }
    if (!(await doArchive(d, row, reason, why))) continue;
    entry.archivedAt = at;
    archived += 1;
    actions.push({ what: 'archive', id: row.id, name: row.name, reason, done: true, why });
    const boss = reachable(row);
    if (boss && boss.id !== row.id) await send(d, boss.id, archivedNote(row.name, row.id, entry.bytes, where)).catch(failed);
  }

  if (apply) writeJson(statePath(d, 'oversize'), { sessions: next });
  return { nudged, archived, actions };
}
