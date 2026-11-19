// The app's sessions as its sidebar lists them, each with what its own history says it is doing. The sidebar comes over the
// app's socket (list_workspaces, list_general_chat_sessions), which is where the coordinator, pull request and automation
// fields are. The history's tail says whether the session is working, waiting on a person, stuck, or idle.
import fs from 'node:fs';
import { ShepherdError } from './error.mjs';
import { readTail } from './history.mjs';

export const HUNG_MS = 30 * 60000;
const STUCK_GRACE_MS = 120000;
const STATUS_TAIL_BYTES = 512 * 1024;
const REQUEST_WAIT_MS = 30000;
const SESSION_ID = /^[A-Za-z0-9-]+$/;
const ASK_TOOLS = new Set(['ask_user', 'ask_followup_question', 'request_user_input']);
const PLAN_TOOLS = new Set(['exit_plan_mode']);
const LOOP = new Set(['user.message', 'assistant.turn_start', 'assistant.message', 'assistant.turn_end', 'abort', 'session.task_complete',
  'tool.execution_start', 'tool.execution_complete', 'subagent.started', 'subagent.completed']);

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const arr = (v) => (Array.isArray(v) ? v.filter(isRecord) : []);

const PERMISSION_WHAT = { shell: 'run a shell command', write: 'change a file', read: 'read a file', url: 'open a web address', mcp: 'use a connected tool', 'custom-tool': 'use a custom tool', 'extension-management': 'change an extension' };

// The request in a few plain words. A command's text stays out: it can carry secrets.
export function describePermission(request) {
  const record = isRecord(request) ? request : {};
  const kind = str(record.kind);
  if (kind === 'extension-permission-access') {
    const capabilities = Array.isArray(record.capabilities) ? record.capabilities.filter((c) => typeof c === 'string').join(', ') : '';
    return `let the extension ${str(record.extensionName) ?? '(unnamed)'} ${capabilities || 'ask for access'}`;
  }
  const what = (kind && PERMISSION_WHAT[kind]) || (kind ? `a ${kind} permission` : 'a permission');
  const intention = str(record.intention);
  return intention ? `${what} (${intention})` : what;
}

export function parseLines(lines) {
  const events = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const e = JSON.parse(line);
      if (isRecord(e)) events.push(e);
    } catch { /* a line cut by the tail window is not an event */ }
  }
  return events;
}

// What the session's own history says about its agent loop. Sub-agent events are their parent's business.
export function tailFacts(events) {
  const tools = new Map();
  const permissions = new Map();
  let last = null, lastActivity = null, askedTools = false, finished = false;
  for (const event of events) {
    if (event.agentId !== undefined) continue;
    const type = str(event.type) ?? '';
    const data = isRecord(event.data) ? event.data : {};
    if (type === 'session.shutdown' || type === 'session.resume' || type === 'session.start') { tools.clear(); permissions.clear(); }
    if (type === 'tool.execution_start' && str(data.toolCallId)) tools.set(data.toolCallId, str(data.toolName) ?? '');
    if (type === 'tool.execution_complete' && str(data.toolCallId)) tools.delete(data.toolCallId);
    if (type === 'permission.requested' && str(data.requestId) && data.resolvedByHook !== true) permissions.set(data.requestId, { requestId: data.requestId, what: describePermission(data.permissionRequest), at: str(event.timestamp) });
    if (type === 'permission.completed' && str(data.requestId)) permissions.delete(data.requestId);
    if (!LOOP.has(type)) continue;
    // Only a person's stop counts; a runtime shutdown cancels sub-agents with other reasons.
    if (type === 'abort' && str(data.reason) && data.reason !== 'user_initiated') continue;
    if (type === 'assistant.message') { askedTools = Array.isArray(data.toolRequests) && data.toolRequests.length > 0; finished = false; }
    if (type === 'session.task_complete') finished = true;
    if (type === 'user.message') { askedTools = false; finished = false; }
    last = type;
    lastActivity = str(event.timestamp) ?? lastActivity;
  }
  const pending = [...tools.values()].map((name) => name.replace(/^[\w-]+?-(?=ask_|exit_)/, ''));
  const awaiting = pending.some((n) => ASK_TOOLS.has(n)) ? 'input' : pending.some((n) => PLAN_TOOLS.has(n)) ? 'plan' : permissions.size > 0 ? 'permission' : null;
  let loopCut = false, detail = 'no agent activity';
  if (last === 'abort') detail = 'stopped by the person';
  else if (last === 'session.task_complete' || (last === 'assistant.turn_end' && finished)) detail = 'task complete';
  else if (last === 'assistant.turn_end') {
    loopCut = askedTools;
    detail = askedTools ? 'between turns (its last turn called tools and no next turn started)' : 'its turn ended';
  } else if (last) { loopCut = true; detail = `mid-turn (last ${last})`; }
  const prompt = permissions.values().next().value;
  return { awaiting, loopCut, detail, lastActivity, ...(prompt ? { prompt } : {}) };
}

export function classify(isRunning, facts, nowMs, writtenAtMs = null) {
  if (facts.awaiting === 'permission') return { state: 'waiting', detail: 'waiting for a permission answer' };
  if (facts.awaiting) return { state: 'waiting', detail: `waiting for the person's ${facts.awaiting === 'plan' ? 'plan approval' : 'answer'}` };
  if (isRunning) {
    if (writtenAtMs !== null && nowMs - writtenAtMs >= HUNG_MS) return { state: 'stuck', detail: `the app says it is running, but its history has not grown for ${Math.round((nowMs - writtenAtMs) / 60000)} min` };
    return { state: 'working', detail: 'the app says it is running' };
  }
  if (facts.loopCut) {
    const at = Date.parse(facts.lastActivity ?? '');
    if (!Number.isNaN(at) && nowMs - at < STUCK_GRACE_MS) return { state: 'working', detail: `starting up (${facts.detail})` };
    return { state: 'stuck', detail: `not running, but its loop stopped ${facts.detail}` };
  }
  return { state: 'idle', detail: facts.detail };
}

// The tail facts of a history, re-read only when the file changed (its size and time), so a minute's pass stays cheap.
const factsCache = new Map();
function factsOf(d, id) {
  const file = d.historyPath(id);
  let key = 'missing', writtenAtMs = null;
  try {
    const st = fs.statSync(file);
    key = `${st.size}:${st.mtimeMs}`;
    writtenAtMs = st.mtimeMs;
  } catch { /* no history yet: the facts of an empty one */ }
  const hit = factsCache.get(file);
  if (hit?.key === key) return hit;
  const entry = { key, facts: tailFacts(parseLines(readTail(file, STATUS_TAIL_BYTES))), writtenAtMs };
  factsCache.set(file, entry);
  return entry;
}

async function sidebarItems(d) {
  const got = await d.exchange([{ type: 'list_workspaces' }, { type: 'list_general_chat_sessions' }], {
    keep: (f) => /^(workspace_list|general_chat_sessions_list|socket_error)$/.test(String(f.type)),
    done: (_f, all) => (all.some((f) => f.type === 'workspace_list') && all.some((f) => f.type === 'general_chat_sessions_list')) || all.some((f) => f.type === 'socket_error'),
    waitMs: REQUEST_WAIT_MS,
  });
  const workspaces = got.find((f) => f.type === 'workspace_list');
  const chats = got.find((f) => f.type === 'general_chat_sessions_list');
  if (!workspaces || !chats) {
    throw new ShepherdError({ code: 'sidebar-unlisted', problem: str(got.find((f) => f.type === 'socket_error')?.message) ?? 'the GitHub Copilot app did not list its sessions in time', fix: 'open the GitHub Copilot app, let it finish starting, and try again; if it is open and still does not list them, it is not answering (frozen, or starved of memory) and needs a restart: housesitter restart-copilot --resume' });
  }
  return { workspaces: arr(workspaces.workspaces), chats: arr(chats.sessions) };
}

// Every session in the app's sidebar (not archived, unless `archived` asks for those too, each marked archived: true), with its state, what the state rests on, and what its history says it
// waits on. Throws ShepherdError when the app is not serving.
export async function rows(d, now = d.now(), { archived = false } = {}) {
  const { workspaces, chats } = await sidebarItems(d);
  const out = [];
  const add = (id, row, isRunning) => {
    if (!id || !SESSION_ID.test(id) || out.some((k) => k.id === id)) return;
    const { facts, writtenAtMs } = factsOf(d, id);
    const { state, detail } = classify(isRunning, facts, now, writtenAtMs);
    out.push({ id, ...row, state, detail, lastActivity: facts.lastActivity ?? row.updatedAt, ...(facts.awaiting ? { awaiting: facts.awaiting } : {}), ...(facts.prompt ? { prompt: facts.prompt } : {}) });
  };
  for (const workspace of workspaces) {
    if (workspace.archivedAt && !archived) continue;
    const session = isRecord(workspace.session) ? workspace.session : {};
    const binding = arr(workspace.checkoutBindings)[0];
    const openPr = arr(workspace.repoContexts).map((c) => (isRecord(c.createdPullRequest) ? c.createdPullRequest : null)).find((pr) => pr && !/^(merged|closed)$/i.test(str(pr.state) ?? ''));
    add(str(session.sessionId) ?? str(workspace.activeSessionId), {
      name: str(workspace.name) ?? str(session.title) ?? '(unnamed)', kind: 'workspace', workspaceId: str(workspace.id), workspaceType: str(workspace.workspaceType),
      project: str(workspace.projectName), projectId: str(workspace.projectId), projectRepo: str(binding?.repoFullName), branch: str(workspace.branch), path: str(workspace.displayPath),
      createdAt: str(workspace.createdAt), creatorSessionId: str(workspace.creatorSessionId), parentSessionId: null,
      coordinatingCreatorSessionId: str(workspace.coordinatingCreatorSessionId), wasInterrupted: session.wasInterrupted === true,
      isRunning: session.isRunning === true, remote: (str(workspace.hostId) ?? 'local') !== 'local' || (str(session.executionLocation) ?? 'local') !== 'local',
      updatedAt: str(session.updatedAt) ?? str(workspace.updatedAt),
      ...(openPr ? { openPullRequest: str(openPr.htmlUrl) ?? `#${String(openPr.number)}` } : {}),
      ...(workspace.archivedAt ? { archived: true } : {}),
      ...(session.sessionAutomation || workspace.agentMergeEnabled === true ? { automation: true } : {}),
    }, session.isRunning === true);
  }
  for (const chat of chats) {
    if (chat.archivedAt && !archived) continue;
    add(str(chat.id), {
      name: str(chat.title) ?? '(unnamed chat)', kind: 'chat', workspaceId: null, workspaceType: null, project: null, projectId: null, projectRepo: null, branch: null, path: null,
      createdAt: str(chat.createdAt), creatorSessionId: null, coordinatingCreatorSessionId: str(chat.coordinatingCreatorSessionId), parentSessionId: str(chat.parentSessionId),
      wasInterrupted: chat.wasInterrupted === true,
      isRunning: chat.isRunning === true, remote: (str(chat.executionLocation) ?? 'local') !== 'local', updatedAt: str(chat.updatedAt),
      ...(chat.archivedAt ? { archived: true } : {}),
    }, chat.isRunning === true);
  }
  return out;
}

// The ids of the sessions the app has archived, which hold no runtime.
export async function archivedIds(d) {
  const { workspaces, chats } = await sidebarItems(d);
  const ids = [];
  for (const workspace of workspaces) {
    const session = isRecord(workspace.session) ? workspace.session : {};
    const id = str(session.sessionId) ?? str(workspace.activeSessionId);
    if (workspace.archivedAt && id) ids.push(id);
  }
  for (const chat of chats) if (chat.archivedAt && str(chat.id)) ids.push(str(chat.id));
  return ids;
}
