// What a Copilot app session's own history (~/.copilot/session-state/<id>/events.jsonl) says about whether its agent loop was
// working at a time T. Kept from app-resume.mjs, retired 2026-11-14 when Housesitter took over resuming sessions after an
// app restart (`housesitter restart-copilot --resume-only`); quota-balance.mjs still reads it to know when a project is quiet.

// Events that say what the agent loop is doing; everything else (session.*, hook.*, model.*, notices) is ignored.
const LOOP = new Set(['user.message', 'assistant.turn_start', 'assistant.message', 'assistant.turn_end', 'abort', 'session.task_complete',
  'tool.execution_start', 'tool.execution_complete', 'subagent.started', 'subagent.completed', 'external_tool.requested', 'external_tool.completed']);
const textOf = (r) => (typeof r === 'string' ? r : r?.content != null ? String(r.content) : JSON.stringify(r ?? ''));

// Pure. lines: events.jsonl lines; T: the app process's start (ms). Was the session's agent loop working at T, and has
// anything continued it since?
export function stateAt(lines, T) {
  let last = null, lastMsg = null, lastAt = 0, running = 0, finished = false;
  let postUser = 0, postTurn = 0, postLoadAt = 0;
  // Work started in the runtime that was alive at T and still owed a report: async shells and background agents.
  let shells = new Map(), agents = new Map();
  const starts = new Map();
  for (const l of lines) {
    if (!l) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const t = Date.parse(e.timestamp || '');
    if (!Number.isFinite(t)) continue;
    if (t > T) { if (e.type === 'user.message') postUser++; if (e.type === 'assistant.turn_start') postTurn++; if (e.type === 'session.resume' || e.type === 'session.start') postLoadAt = t; continue; }
    const d = e.data || {};
    // A runtime (re)load: shells and agents of the runtime before it are gone and will never report.
    if (e.type === 'session.start' || e.type === 'session.resume') { shells = new Map(); agents = new Map(); running = 0; }
    if (e.type === 'tool.execution_start') starts.set(d.toolCallId, d);
    if (e.type === 'tool.execution_complete') {
      const s = starts.get(d.toolCallId);
      const out = textOf(d.result);
      if (s?.toolName === 'bash' && s.arguments?.mode === 'async') {
        const id = (out.match(/shellId:\s*([^\s>"\\]+)/) || [])[1] || s.arguments?.shellId;
        if (id && !/completed with exit code|has completed/i.test(out)) shells.set(String(id), s.arguments?.description || 'shell');
      }
      if (s && (s.toolName === 'read_bash' || s.toolName === 'stop_bash') && s.arguments?.shellId != null) {
        if (s.toolName === 'stop_bash' || /completed with exit code|has completed|no (such )?shell|not found|stopped/i.test(out)) shells.delete(String(s.arguments.shellId));
      }
    }
    if (e.type === 'system.notification') {
      const k = d.kind || {};
      if (k.shellId != null) shells.delete(String(k.shellId));
      if (k.agentId) agents.delete(k.agentId);
    }
    if (e.type === 'subagent.started' && d.executionMode === 'background') { agents.set(e.agentId || d.toolCallId, d.agentDisplayName || d.agentName || 'agent'); continue; }
    if ((e.type === 'subagent.completed' || e.type === 'subagent.failed') && agents.has(e.agentId || d.toolCallId)) { agents.delete(e.agentId || d.toolCallId); continue; }
    if (!LOOP.has(e.type)) continue;
    // Only a person's stop counts; a runtime shutdown cancels its subagents with abort "subagent_cancelled"
    // (2026-11-09 23:45:20, the coordinator 6788596e, which the operator then had to tell "go on").
    if (e.type === 'abort' && d.reason && d.reason !== 'user_initiated') continue;
    if (e.type === 'subagent.started') running++;
    if (e.type === 'subagent.completed') running = Math.max(0, running - 1);
    if (e.type === 'assistant.message') { lastMsg = e; finished = false; }
    if (e.type === 'session.task_complete') finished = true;
    if (e.type === 'user.message') { lastMsg = null; running = 0; finished = false; }
    last = e.type; lastAt = t;
  }
  const owed = [...[...shells.values()].map((x) => `shell "${x}"`), ...[...agents.values()].map((x) => `background agent ${x}`)];
  let working = false, why = 'no agent activity';
  if (last === 'abort') why = 'stopped by the person';
  else if (last === 'session.task_complete' || (last === 'assistant.turn_end' && finished)) why = 'task complete';
  else if (last === 'assistant.turn_end') {
    // A turn that asked for tools is followed by another turn; ending there means the loop was cut between turns.
    const asked = (lastMsg?.data?.toolRequests || []).length > 0;
    working = asked || running > 0 || owed.length > 0;
    why = asked ? 'between turns (its last turn called tools and no next turn started)'
      : running > 0 ? `${running} subagent(s) still running`
        : owed.length ? `waiting on ${owed.slice(0, 3).join(', ')}${owed.length > 3 ? ` and ${owed.length - 3} more` : ''}`
          : 'its turn had ended';
  } else if (last) { working = true; why = `mid-turn (last ${last})`; }
  return { working, why, lastAt, postUser, postTurn, postLoadAt, owed };
}
