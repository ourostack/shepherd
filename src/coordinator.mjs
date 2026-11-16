// Who coordinates a session now. The app records a coordinator once, when the session is made, and never lets another session
// take that field over: when the coordinator hands off to a successor and is archived, the field still names the archived one,
// while the lanes report to the successor. So the field alone is not the truth. In order:
//
// - `app`: the session the app names, when it is still in the sidebar (by session id or workspace id);
// - `hand-off`: that session's successor, when a hand-off names one that is listed (handoff.mjs);
// - `reports`: the listed session this lane last sent a message to with send_session_message, read from the end of its history.
//
// `gone` means none of these finds one: only then may anyone say the lane has no coordinator.
import { readTail } from './history.mjs';
import { readSuccessions, successorOf } from './handoff.mjs';

export const REPORT_SCAN_BYTES = 16 * 1024 * 1024;
const SEND_TOOL = /(?:^|-)send_session_message$/;

// successorOf over the hand-offs on record, read once, when first needed.
export function handoffSuccessors(d) {
  let successions = null;
  return (id) => successorOf(id, (successions ??= readSuccessions(d)));
}

const listedAs = (rows, id) => (id ? rows.find((row) => row.id === id || row.workspaceId === id) : undefined);

// The session ids this lane sent messages to, oldest first, from the end of its history.
export function reportTargets(id, d, maxBytes = REPORT_SCAN_BYTES) {
  const targets = [];
  for (const line of readTail(d.historyPath(id), maxBytes, { keepPartial: true })) {
    if (!line.includes('send_session_message')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const request of event?.data?.toolRequests ?? []) {
      if (typeof request?.name !== 'string' || !SEND_TOOL.test(request.name)) continue;
      let args = request.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { continue; }
      }
      const target = args?.session_id;
      if (typeof target === 'string' && target) targets.push(target);
    }
  }
  return targets;
}

export function coordinatorOf(row, rows, { d, successorOf: successor } = {}) {
  const recorded = row.coordinatingCreatorSessionId;
  if (!recorded) return null;
  const named = listedAs(rows, recorded);
  if (named && named.id !== row.id) return { id: named.id, name: named.name, via: 'app' };
  const heir = listedAs(rows, successor?.(recorded));
  if (heir && heir.id !== row.id) return { id: heir.id, name: heir.name, via: 'hand-off' };
  if (d) {
    const latest = reportTargets(row.id, d).reverse().map((target) => listedAs(rows, target)).find((target) => target && target.id !== row.id);
    if (latest) return { id: latest.id, name: latest.name, via: 'reports' };
  }
  return { gone: true, recorded };
}
