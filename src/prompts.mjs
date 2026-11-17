// The questions and plan approvals the app's sessions are blocked on. The app announces each one once, as a frame to the
// observers connected at that moment, and never repeats it to one that connects later, so `answer` and `plan` work only for
// what a tracker heard. listenPrompts keeps one observer connection open (the resident watch starts it) and records what it
// hears in the state folder, where those verbs read it.
import { readPending, writePending } from './store.mjs';
import { socketUrl } from './socket.mjs';

export const KEEP_MS = 24 * 3600000;
const RETRY_MS = 30000;

const text = (value) => (typeof value === 'string' && value ? value : undefined);

// Applies one frame to the open requests (by session id). True when they changed.
export function applyFrame(pending, frame, at) {
  const session = text(frame?.session_id);
  const requestId = text(frame?.request_id);
  if (!session || !requestId) return false;
  if (frame.type === 'user_input_request') {
    pending[session] = {
      kind: 'input', requestId, at, ...(text(frame.question) ? { question: text(frame.question) } : {}),
      ...(Array.isArray(frame.choices) ? { choices: frame.choices.filter((c) => typeof c === 'string') } : {}),
      ...(typeof frame.allow_freeform === 'boolean' ? { allowFreeform: frame.allow_freeform } : {}),
    };
    return true;
  }
  if (frame.type === 'exit_plan_mode_request') {
    pending[session] = {
      kind: 'plan', requestId, at, ...(text(frame.summary) ? { summary: text(frame.summary) } : {}),
      ...(Array.isArray(frame.actions) ? { actions: frame.actions.filter((a) => typeof a === 'string') } : {}),
    };
    return true;
  }
  if ((frame.type === 'user_input_resolved' || frame.type === 'exit_plan_mode_resolved') && pending[session]?.requestId === requestId) {
    delete pending[session];
    return true;
  }
  return false;
}

// Keeps one observer connection to the app and records what it announces. Reconnects every 30 s while the app is down.
// Returns { stop }. Requests older than a day are dropped when it starts.
export function listenPrompts(d, { retryMs = RETRY_MS, now = () => d.now() } = {}) {
  const pending = Object.fromEntries(Object.entries(readPending(d)).filter(([, request]) => now() - Date.parse(request.at) < KEEP_MS));
  let socket = null;
  let stopped = false;
  let timer = null;
  const again = () => { if (!stopped) { clearTimeout(timer); timer = setTimeout(connect, retryMs); } };
  function connect() {
    if (stopped) return;
    let url;
    try { url = socketUrl(d.copilotHome); } catch { return again(); }
    try { socket = new WebSocket(url); } catch { return again(); }
    socket.addEventListener('message', (e) => {
      const raw = String(e.data);
      if (!/^\{"type":"(user_input_re|exit_plan_mode_re)/.test(raw)) return;
      let frame;
      try { frame = JSON.parse(raw); } catch { return; }
      if (applyFrame(pending, frame, new Date(now()).toISOString())) writePending(d, pending);
    });
    socket.addEventListener('close', again);
    socket.addEventListener('error', () => { try { socket.close(); } catch { /* gone */ } again(); });
  }
  connect();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* closed */ }
    },
  };
}
