// The GitHub Copilot app's sessions, operated the way a coordinating session uses the app's client tools: each function is one
// request (or a few) on the app's local socket, answered in the app's shapes, with the rules the tools kept: who may be
// archived, how a message is confirmed, and which question or plan may be answered. Reads come from rows.mjs and the
// session's own history; the state the rules need (what this agent created, what the app announced) lives in the state folder.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { ShepherdError } from './error.mjs';
import { coordinatorOf, handoffSuccessors } from './coordinator.mjs';
import { readSuccessions, successorOf } from './handoff.mjs';
import { messagesIn, readTail, TAIL_BYTES } from './history.mjs';
import { restoreHistory } from './compress.mjs';
import { readOversize } from './size-watch.mjs';
import { addProbe, logArchive, readPending, readProbes, removeProbe } from './store.mjs';
import { archive } from './socket.mjs';
import { rows } from './rows.mjs';

const REQUEST_WAIT_MS = 30000;
const CREATE_WAIT_MS = 300000;
const ARCHIVE_WAIT_MS = 60000;
const ANSWER_WAIT_MS = 15000;
export const SEND_WAIT_MS = 120000;
export const PREFIX_MIN = 8;
const SESSION_ID = /^[A-Za-z0-9-]+$/;
const MESSAGE_WINDOWS = [TAIL_BYTES, 16 * 1024 * 1024, 64 * 1024 * 1024];
const COORDINATION_NOTE = 'an outside client cannot be a session\'s coordinator, so the app will not report back: read the session with shepherd session or shepherd messages to see its replies';
const STATE_OF = { busy: 'working', idle: 'idle', waiting: 'waiting', stuck: 'stuck' };
export const SESSION_STATES = Object.keys(STATE_OF);

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
export const appUrl = (id) => `ghapp://sessions/${id}`;
const reasonOf = (f) => str(f.error) ?? str(f.message) ?? str(f.reason) ?? str(f.detail) ?? String(f.type);

// One request and its answer: the frame `settle` calls ok, or the reason it was refused, or that the app did not answer in time.
// settle returns 'ok', 'fail', 'wait' (keep waiting) or 'ignore' (not this request's answer).
export async function ask(d, frame, settle, waitMs) {
  const requestId = str(frame.request_id) ?? randomUUID();
  const verdict = (reply) => (reply.type === 'socket_error' || reply.type === 'error' ? 'fail' : settle(reply, requestId));
  const got = await d.exchange([{ ...frame, request_id: requestId }], { keep: (r) => verdict(r) !== 'ignore', done: (r) => /^(ok|fail)$/.test(verdict(r)), waitMs });
  const last = got.at(-1);
  if (last && verdict(last) === 'ok') return { ok: true, frame: last, error: null };
  return { ok: false, frame: last ?? null, error: last && verdict(last) === 'fail' ? reasonOf(last) : 'the app did not answer in time' };
}

// A session by its id or its workspace id, or a unique start of either of at least PREFIX_MIN characters.
export function findSession(listed, value) {
  const wanted = str(value)?.trim() ?? '';
  if (!wanted) throw new ShepherdError({ code: 'no-session', problem: 'no session id was given', fix: 'name a session: its id, or the first 8 characters of it, from shepherd sessions' });
  const exact = listed.find((r) => r.id === wanted) ?? listed.find((r) => r.workspaceId === wanted);
  if (exact) return exact;
  if (wanted.length < PREFIX_MIN) throw new ShepherdError({ code: 'short-id', problem: `'${wanted}' is not a whole session id, and a start of one needs ${PREFIX_MIN} or more characters`, fix: 'give the whole id, or the first 8 characters, from shepherd sessions' });
  const matches = listed.filter((r) => r.id.startsWith(wanted) || r.workspaceId?.startsWith(wanted));
  if (matches.length === 1) return matches[0];
  if (matches.length) throw new ShepherdError({ code: 'ambiguous-session', problem: `'${wanted}' matches ${matches.length} sessions`, fix: 'give more of the id, from shepherd sessions' });
  throw new ShepherdError({ code: 'no-session', problem: `no session '${wanted}' in the Copilot app`, fix: 'list the sessions with shepherd sessions' });
}

const resolve = async (d, value) => findSession(await rows(d), value);

// Who coordinates a session now, beside the app's own field (see coordinator.mjs).
function coordination(row, listed, d, successors) {
  const found = coordinatorOf(row, listed, { d, successorOf: successors });
  if (!found) return {};
  if ('gone' in found) return { coordinator_gone: true };
  return { coordinator_session_id: found.id, coordinator_name: found.name, ...(found.via === 'app' ? {} : { coordinator_found_by: found.via }) };
}

function item(row, listed, d, successors) {
  return compact({
    type: row.kind === 'chat' ? 'chat' : 'session', id: row.id, app_url: appUrl(row.id), name: row.name, project_id: row.projectId, project_name: row.project, project_repo: row.projectRepo,
    branch: row.branch, path: row.path, created_at: row.createdAt, updated_at: row.updatedAt, creator_session_id: row.creatorSessionId,
    coordinating_creator_session_id: row.coordinatingCreatorSessionId, ...coordination(row, listed, d, successors), parent_session_id: row.parentSessionId, is_running: row.isRunning, ...(row.remote ? { remote: true } : {}),
  });
}

// What an answer needs from a session blocked on something: the request's id and what it asks, or why the id is unknown.
function awaitingInput(row, pending) {
  const request = pending[row.id];
  if (row.awaiting === 'permission') return { kind: 'permission', request_id: row.prompt?.requestId ?? null, what: row.prompt?.what, note: 'answer it in the app; the app\'s own tools do not answer permissions either' };
  if (row.awaiting === 'input' || row.awaiting === 'plan') {
    const kind = row.awaiting === 'plan' ? 'plan' : 'user_input';
    if (request && (request.kind === 'plan') === (kind === 'plan')) {
      return compact({ kind, request_id: request.requestId, question: request.question, choices: request.choices, allow_freeform: request.allowFreeform, summary: request.summary, actions: request.actions });
    }
    return { kind, request_id: null, note: 'it was asked while no tracker was connected to the app, which announces a question only once; the person can answer it in the app' };
  }
  return undefined;
}

function status(row, listed, pending, d, successors) {
  const input = awaitingInput(row, pending);
  return compact({
    ...item(row, listed, d, successors), was_interrupted: row.wasInterrupted || null,
    activity: compact({ status: row.state === 'working' ? 'busy' : row.state, why: row.detail, last_activity: row.lastActivity }),
    awaiting_user_input: row.awaiting === 'input', awaiting_plan_approval: row.awaiting === 'plan', awaiting_permission: row.awaiting === 'permission',
    awaiting_input: input,
  });
}

// ---------- reading ----------

// Every session in the sidebar with its status, counts by state; `state` keeps only the sessions in that state.
export async function sessions(d, { state } = {}) {
  const listed = await rows(d);
  const pending = readPending(d);
  const successors = handoffSuccessors(d);
  const count = (keep) => listed.filter(keep).length;
  const want = state ? STATE_OF[state] : undefined;
  return {
    summary: {
      total: listed.length, running: count((r) => r.isRunning), busy: count((r) => r.state === 'working'), blocked: count((r) => r.state === 'waiting'), stuck: count((r) => r.state === 'stuck'),
      awaiting_user_input: count((r) => r.awaiting === 'input'), awaiting_plan_approval: count((r) => r.awaiting === 'plan'),
    },
    sessions: listed.filter((r) => !want || r.state === want).map((r) => status(r, listed, pending, d, successors)),
  };
}

export async function session(d, id) {
  const listed = await rows(d);
  return status(findSession(listed, id), listed, readPending(d), d, handoffSuccessors(d));
}

// The last `count` user and assistant messages of a session, oldest first, from its history. The read widens (4 MB, 16 MB,
// then 64 MB) until it has enough messages or reaches the beginning of the log.
export function readMessages(d, id, count = 6) {
  const requested = Math.min(50, Math.max(1, Math.trunc(Number(count)) || 1));
  const base = { messages: [], observedAt: new Date(d.now()).toISOString(), source: 'local_event_log', requestedCount: requested, returnedCount: 0, logBytes: 0, scannedBytes: 0, beginningReached: false, skippedEvents: 0, missing: false };
  const file = d.historyPath(id);
  let size;
  try { size = fs.statSync(file).size; } catch { return { ...base, missing: true }; }
  let all = [], scanned = 0, skipped = 0;
  for (const bytes of MESSAGE_WINDOWS) {
    const events = [];
    skipped = 0;
    for (const line of readTail(file, bytes)) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (isRecord(event)) events.push(event);
        else skipped += 1;
      } catch { skipped += 1; }
    }
    all = messagesIn(events);
    scanned = Math.min(bytes, size);
    if (all.length >= requested || scanned >= size) break;
  }
  const messages = all.slice(-requested);
  return { ...base, messages, returnedCount: messages.length, logBytes: size, scannedBytes: scanned, beginningReached: scanned >= size, skippedEvents: skipped };
}

export async function messages(d, id, count = 6) {
  const listed = await rows(d);
  const row = findSession(listed, id);
  const history = readMessages(d, row.id, count);
  return {
    session_id: row.id, name: row.name, state: row.state, last_activity: row.lastActivity, ...history,
    coverage: history.missing ? 'missing' : history.skippedEvents ? 'incomplete' : row.remote ? 'local-only' : 'local',
    freshness: 'point-in-time; re-read before reporting current progress',
  };
}

// ---------- writing ----------

// Puts a message into a session, as its message box does, and waits for the app to accept it (a session that is not loaded loads
// first). A message the app began to deliver and did not confirm in time is not called lost: the caller reads the session first.
export async function deliver(d, id, message, mode) {
  await restoreHistory(d, id).catch(() => undefined);
  let interim = false;
  const sent = await ask(d, { type: 'send_message', session_id: id, prompt: message, delivery_mode: mode }, (reply, requestId) => {
    if (/^session_message_(sent|queued)$/.test(String(reply.type)) && reply.request_id === requestId) return 'ok';
    if (reply.type === 'session_dispatch_state' && reply.request_id === requestId) {
      interim ||= reply.dispatch_may_have_started === true;
      return 'wait';
    }
    return reply.request_id === requestId || (reply.session_id === id && /^session_(message_delivery_unknown|resume_failed)$/.test(String(reply.type))) ? 'fail' : 'ignore';
  }, d.sendWaitMs ?? SEND_WAIT_MS);
  const unconfirmed = !sent.ok && interim && sent.frame?.type === 'session_dispatch_state';
  return unconfirmed ? { ...sent, error: 'the app began delivering the message but had not confirmed it in time; read the session before sending it again' } : sent;
}

const deliveryResult = (row, sent) => compact({
  ok: sent.ok, status: sent.ok ? (sent.frame?.type === 'session_message_queued' ? 'queued' : 'accepted') : 'failed', session_id: row.id, name: row.name,
  message_id: str(sent.frame?.message_id), error: sent.error,
});

export async function send(d, args) {
  const message = typeof args.message === 'string' ? args.message : '';
  if (!message.trim()) throw new ShepherdError({ code: 'no-message', problem: 'the message is empty', fix: 'pass --message <text>' });
  const row = await resolve(d, args.session_id);
  return deliveryResult(row, await deliver(d, row.id, message, args.delivery_mode === 'enqueue' ? 'enqueue' : 'immediate'));
}

// The project a create request names: its id, or its name, as the app lists it.
async function projectId(d, value) {
  const listed = await ask(d, { type: 'list_projects' }, (reply) => (reply.type === 'project_list' ? 'ok' : 'ignore'), REQUEST_WAIT_MS);
  if (!listed.ok) throw new ShepherdError({ code: 'projects-unlisted', problem: `the app did not list its projects (${listed.error})`, fix: 'open the GitHub Copilot app, let it finish starting, and try again' });
  const projects = Array.isArray(listed.frame?.projects) ? listed.frame.projects.filter(isRecord) : [];
  const found = projects.find((p) => p.id === value) ?? projects.find((p) => p.name === value);
  if (!found) throw new ShepherdError({ code: 'no-project', problem: `no project '${value}' in the Copilot app${projects.length ? ` (it has: ${projects.map((p) => str(p.name) ?? '?').join(', ')})` : ''}`, fix: 'pass a project id or name from shepherd sessions' });
  return found.id;
}

// Starts a session: a project session in its own worktree (or on the project's checkout), or a standalone chat. Records it as
// created here, so this agent may archive it.
export async function create(d, args) {
  const kickoff = isRecord(args.kickoff) ? args.kickoff : {};
  const prompt = str(kickoff.prompt);
  const name = str(args.name);
  const project = str(args.project_id);
  const chat = args.session_kind === 'chat' || (!project && args.session_kind !== 'project');
  if (!chat && !project) throw new ShepherdError({ code: 'no-project', problem: 'a project session needs a project (its id or name; shepherd sessions shows project_id on its sessions)', fix: 'pass --project <id or name>, or --session-kind chat for a standalone chat' });
  const settleCreate = (reply, requestId) => (reply.request_id === requestId ? (reply.type === 'session_created' ? 'ok' : 'fail') : 'ignore');
  let created;
  if (chat) {
    created = await ask(d, { type: 'create_session', cwd: os.homedir(), session_type: 'general_chat', ...(str(kickoff.model) ? { model: str(kickoff.model) } : {}), ...(str(kickoff.agent) ? { agent: str(kickoff.agent) } : {}) }, settleCreate, REQUEST_WAIT_MS);
  } else {
    const worktree = args.workspace_type !== 'branch';
    created = await ask(d, {
      type: worktree ? 'create_worktree_workspace' : 'create_branch_workspace', project_id: await projectId(d, project),
      ...(worktree ? { branch_name: str(args.branch_name) ?? `shepherd-${randomUUID().slice(0, 8)}`, checkout_existing_branch: false } : {}),
      ...(name ? { name } : {}), kickoff_permission_mode: str(kickoff.permission_mode) ?? 'allow-all',
      ...(str(kickoff.model) ? { kickoff_model: str(kickoff.model) } : {}), ...(str(kickoff.agent) ? { kickoff_agent: str(kickoff.agent) } : {}),
      ...(str(kickoff.reasoning_effort) ? { kickoff_reasoning_effort: str(kickoff.reasoning_effort) } : {}),
    }, (reply, requestId) => (reply.request_id === requestId ? (reply.type === 'workspace_created' ? 'ok' : reply.type === 'workspace_changed' ? 'wait' : 'fail') : reply.type === 'session_creation_failed' ? 'fail' : 'ignore'), CREATE_WAIT_MS);
    // The app opens a workspace's session only for its own window, so this client opens it.
    if (created.ok) {
      const workspace = isRecord(created.frame.workspace) ? created.frame.workspace : {};
      const workspaceId = str(workspace.id);
      const cwd = str(workspace.displayPath);
      if (workspaceId && cwd) created = await ask(d, { type: 'create_session', workspace_id: workspaceId, cwd }, settleCreate, REQUEST_WAIT_MS);
    }
  }
  const id = str(created.frame?.session_id);
  if (!created.ok || !id) return { ok: false, created: false, error: created.error ?? 'the app did not name the session it made' };
  if (!SESSION_ID.test(id)) throw new ShepherdError({ code: 'bad-session-id', problem: `the app named '${id}', which is not a session id`, fix: 'open the session in the app and check it' });
  addProbe(d, id, name, d.now());
  // The app runs no kickoff for a client that is not its window, so the name, mode and first message are set here.
  if (chat && name) await ask(d, { type: 'rename_session', session_id: id, title: name }, (reply) => (reply.type === 'session_title_updated' && reply.session_id === id ? 'ok' : 'ignore'), REQUEST_WAIT_MS);
  const mode = str(kickoff.mode);
  if (mode && mode !== 'interactive') await ask(d, { type: 'set_session_mode', session_id: id, mode }, (reply) => (reply.type === 'session_mode_result' && reply.session_id === id ? 'ok' : 'ignore'), REQUEST_WAIT_MS);
  const sent = prompt ? await deliver(d, id, prompt, 'immediate') : null;
  const error = sent && !sent.ok ? `created, but the first message was not accepted: ${sent.error}` : null;
  return compact({ ok: error === null, created: true, session_id: id, app_url: appUrl(id), kind: chat ? 'chat' : 'session', workspace_id: str(created.frame?.workspace_id), coordination: COORDINATION_NOTE, error });
}

// Answers the question a session asked with ask_user. Only a question this agent heard asked can be answered: the app
// announces each once, to the observers connected then.
export async function answer(d, args) {
  const text = typeof args.answer === 'string' ? args.answer : '';
  if (!text) throw new ShepherdError({ code: 'no-answer', problem: 'the answer is empty', fix: 'pass --answer <text>' });
  const row = await resolve(d, args.session_id);
  const request = readPending(d)[row.id];
  if (row.awaiting !== 'input' || request?.kind !== 'input') throw new ShepherdError({ code: 'not-waiting', problem: `session ${row.id} is not waiting on a question this agent heard asked (shepherd session shows what it waits on)`, fix: 'answer it in the app, or keep shepherd watch --every running so that questions are heard' });
  const answered = await ask(d, { type: 'respond_to_user_input', session_id: row.id, request_id: request.requestId, answer: text, was_freeform: !(request.choices ?? []).includes(text) },
    (reply) => (reply.type === 'user_input_resolved' && reply.request_id === request.requestId ? 'ok' : 'ignore'), ANSWER_WAIT_MS);
  return compact({ ok: answered.ok, session_id: row.id, error: answered.error });
}

// Approves or rejects a plan a session is paused on, and sends its feedback after the decision.
export async function plan(d, args) {
  const row = await resolve(d, args.session_id);
  const request = readPending(d)[row.id];
  if (row.awaiting !== 'plan' || request?.kind !== 'plan') throw new ShepherdError({ code: 'not-waiting', problem: `session ${row.id} is not waiting on a plan this agent heard presented (shepherd session shows what it waits on)`, fix: 'approve it in the app, or keep shepherd watch --every running so that plans are heard' });
  const approved = args.approved === true || args.approved === 'true';
  const responded = await ask(d, { type: 'respond_to_exit_plan_mode', session_id: row.id, request_id: request.requestId, approved, ...(str(args.selected_action) ? { selected_action: str(args.selected_action) } : {}) },
    (reply) => (reply.request_id === request.requestId ? (reply.type === 'exit_plan_mode_resolved' ? 'ok' : reply.type === 'exit_plan_mode_response_failed' ? 'fail' : 'ignore') : 'ignore'), ANSWER_WAIT_MS);
  const feedback = str(args.feedback);
  const told = responded.ok && feedback ? await deliver(d, row.id, feedback, 'immediate') : null;
  return compact({ ok: responded.ok, approved, session_id: row.id, feedback_sent: told ? told.ok : undefined, error: responded.error });
}

// A session whose successor (a later session's first message says `Succeeds:` it) is listed, and which is flagged oversize.
function handedOff(d, row) {
  if (!readOversize(d)[row.id]) return false;
  return successorOf(row.id, readSuccessions(d)) !== null;
}

// Archives a session. A session this agent did not create is archived only when the owner asked for it (owner_asked) or it is
// oversize and a newer session names it as handed off. Archiving a workspace deletes its worktree.
export async function archiveSession(d, args) {
  const row = await resolve(d, args.session_id);
  const made = readProbes(d);
  let reason = null;
  if (!made[row.id]) {
    reason = args.owner_asked === true ? 'owner-asked' : handedOff(d, row) ? 'handed-off' : null;
    if (!reason) throw new ShepherdError({ code: 'not-created-here', problem: `session ${row.id} was not created by this agent, so it will not archive it unless the owner asked for it or it is oversize and a newer session names it as handed off (yours: ${Object.keys(made).join(', ') || 'none'})`, fix: 'pass --owner-asked only when the owner asked for this session in this conversation' });
  }
  // Not compressed: the app's own archive is all Ouroboros's archive did, and a history stays readable until someone asks.
  const archived = await archive(d, row, { waitMs: ARCHIVE_WAIT_MS, compress: false });
  if (archived.ok) {
    removeProbe(d, row.id);
    if (reason) logArchive(d, { id: row.id, name: row.name, reason });
  }
  return compact({ ok: archived.ok, session_id: row.id, error: archived.error });
}

// Shows a session in the app's window, as following its link does.
export async function show(d, id) {
  const row = await resolve(d, id);
  const shown = await ask(d, { type: 'handle_deep_link', url: appUrl(row.id) }, (reply) => (reply.type === 'deep_link_received' ? 'ok' : 'ignore'), REQUEST_WAIT_MS);
  return compact({ ok: shown.ok, session_id: row.id, app_url: appUrl(row.id), error: shown.error });
}

// ---------- automations and workflows ----------

export const AUTOMATION_KEYS = ['prompt', 'interval', 'run_at', 'every_minutes', 'schedule_hour', 'schedule_day', 'schedule_minute', 'cron_expression', 'name'];
const settleMutation = (reply, requestId) => (reply.request_id === requestId && reply.type === 'session_automation_mutation_result' ? (reply.error ? 'fail' : 'ok') : 'ignore');
const ownedAutomations = (d, sessionId) => ask(d, { type: 'list_owned_session_automations', session_id: sessionId },
  (reply, requestId) => (reply.request_id === requestId && reply.type === 'owned_session_automations_result' ? 'ok' : 'ignore'), REQUEST_WAIT_MS);

// Creates or replaces the automation that wakes a session on a schedule (only the fields given are sent), or clears it.
export async function automation(d, args) {
  const row = await resolve(d, args.session_id);
  if (args.clear === true) {
    const owned = await ownedAutomations(d, row.id);
    const first = Array.isArray(owned.frame?.automations) ? owned.frame.automations.filter(isRecord)[0] : undefined;
    if (!str(first?.id)) return compact({ ok: false, session_id: row.id, error: owned.error ?? 'that session has no automation to clear' });
    const cleared = await ask(d, { type: 'cancel_session_automation', session_id: row.id, automation_id: first.id }, settleMutation, REQUEST_WAIT_MS);
    return compact({ ok: cleared.ok, session_id: row.id, cleared: cleared.ok, error: cleared.error });
  }
  const fields = Object.fromEntries(AUTOMATION_KEYS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
  const saved = await ask(d, { type: 'save_session_automation', session_id: row.id, ...fields }, settleMutation, REQUEST_WAIT_MS);
  return compact({ ok: saved.ok, session_id: row.id, automation: saved.frame?.automation, error: saved.error });
}

// The automations attached to a session.
export async function automationOf(d, id) {
  const row = await resolve(d, id);
  const owned = await ownedAutomations(d, row.id);
  return compact({ ok: owned.ok, session_id: row.id, automations: owned.frame?.automations, schedules: owned.frame?.legacy_schedules, error: owned.error });
}

export async function workflows(d) {
  const listed = await ask(d, { type: 'list_workflows' }, (reply, requestId) => (reply.request_id === requestId && reply.type === 'workflow_list' ? 'ok' : 'ignore'), REQUEST_WAIT_MS);
  return compact({ ok: listed.ok, workflows: listed.frame?.tasks, error: listed.error });
}

export async function runWorkflow(d, id) {
  const workflow = str(id);
  if (!workflow) throw new ShepherdError({ code: 'no-workflow', problem: 'the workflow is not named', fix: 'name the workflow by its id, from shepherd workflows' });
  const started = await ask(d, { type: 'run_workflow_now', id: workflow }, (reply) => (reply.type === 'workflow_run_started' ? 'ok' : reply.type === 'workflow_run_rejected' ? 'fail' : 'ignore'), REQUEST_WAIT_MS);
  return compact({ ok: started.ok, run: started.frame?.run, error: started.error });
}
