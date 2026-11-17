// The agent-facing verbs of `shepherd`: each reads its arguments as flags or as one JSON object on stdin (`--input -`), runs one
// operation from operate.mjs, and prints its result. With --json the result is one line of JSON (on failure too, with ok false);
// without it, a short text. Keys in the JSON input are the tool arguments the operations take (session_id, delivery_mode,
// kickoff: { prompt, mode, … }); flags are their kebab-case names. Flags win over input. A message to a session goes as a
// peer message from Ouroboros; --as-user (as_user) sends the owner's own relayed words as a labelled user prompt instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShepherdError } from './error.mjs';
import { deps } from './sessions.mjs';
import { AUTOMATION_KEYS, SESSION_STATES, answer, archiveSession, automation, automationOf, create, messages, plan, runWorkflow, send, session, sessions, show, workflows } from './operate.mjs';

const ENUM = (values) => ({ kind: 'enum', values });
const TYPES = {
  state: ENUM(SESSION_STATES), count: { kind: 'int' }, session_id: { kind: 'string' }, id: { kind: 'string' }, message: { kind: 'string' },
  delivery_mode: ENUM(['immediate', 'enqueue']), name: { kind: 'string' }, project_id: { kind: 'string' }, session_kind: ENUM(['chat', 'project']),
  workspace_type: ENUM(['worktree', 'branch']), branch_name: { kind: 'string' }, answer: { kind: 'string' }, approved: { kind: 'bool' },
  selected_action: { kind: 'string' }, feedback: { kind: 'string' }, owner_asked: { kind: 'bool' }, as_user: { kind: 'bool' }, clear: { kind: 'bool' }, prompt: { kind: 'string' },
  interval: ENUM(['once', 'minutes', 'daily', 'weekly', 'cron']), run_at: { kind: 'string' }, every_minutes: { kind: 'number' }, schedule_hour: { kind: 'number' },
  schedule_minute: { kind: 'number' }, schedule_day: { kind: 'number' }, cron_expression: { kind: 'string' },
  'kickoff.prompt': { kind: 'string' }, 'kickoff.mode': ENUM(['interactive', 'plan', 'autopilot']), 'kickoff.model': { kind: 'string' }, 'kickoff.agent': { kind: 'string' },
  'kickoff.reasoning_effort': { kind: 'string' }, 'kickoff.permission_mode': ENUM(['allow-all', 'manual']),
};
const KICKOFF_KEYS = ['prompt', 'mode', 'model', 'agent', 'reasoning_effort', 'permission_mode'];

// Each verb: its usage line, the positional argument (if any), its value flags [flag, key], and its switches [flag, key].
export const AGENT_VERBS = {
  sessions: { usage: 'shepherd sessions [--state busy|idle|waiting|stuck] [--json]', options: [['state', 'state']] },
  session: { usage: 'shepherd session <id> [--json]', positional: 'session_id' },
  messages: { usage: 'shepherd messages <id> [--count <n>] [--json]', positional: 'session_id', options: [['count', 'count']] },
  send: { usage: 'shepherd send <id> --message <text> [--delivery immediate|enqueue] [--as-user] [--json]', positional: 'session_id', options: [['message', 'message'], ['delivery', 'delivery_mode']], switches: [['as-user', 'as_user']] },
  create: {
    usage: 'shepherd create [--project <id|name> | --session-kind chat] [--name <title>] [--workspace-type worktree|branch] [--branch <name>] [--prompt <text>] [--mode interactive|plan|autopilot] [--model <m>] [--agent <a>] [--reasoning-effort <e>] [--permission-mode allow-all|manual] [--as-user] [--json]',
    options: [['project', 'project_id'], ['session-kind', 'session_kind'], ['name', 'name'], ['workspace-type', 'workspace_type'], ['branch', 'branch_name'], ['prompt', 'kickoff.prompt'], ['mode', 'kickoff.mode'], ['model', 'kickoff.model'], ['agent', 'kickoff.agent'], ['reasoning-effort', 'kickoff.reasoning_effort'], ['permission-mode', 'kickoff.permission_mode']],
    switches: [['as-user', 'as_user']],
  },
  answer: { usage: 'shepherd answer <id> --answer <text> [--json]', positional: 'session_id', options: [['answer', 'answer']] },
  plan: { usage: 'shepherd plan <id> --approved true|false [--action <option>] [--feedback <text>] [--as-user] [--json]', positional: 'session_id', options: [['approved', 'approved'], ['action', 'selected_action'], ['feedback', 'feedback']], switches: [['as-user', 'as_user']], required: ['approved'] },
  archive: { usage: 'shepherd archive <id> [--owner-asked] [--json]', positional: 'session_id', switches: [['owner-asked', 'owner_asked']] },
  automation: {
    usage: 'shepherd automation <id> [--clear | --interval once|minutes|daily|weekly|cron --prompt <text> …] [--json]', positional: 'session_id',
    options: [['prompt', 'prompt'], ['interval', 'interval'], ['run-at', 'run_at'], ['every-minutes', 'every_minutes'], ['schedule-hour', 'schedule_hour'], ['schedule-minute', 'schedule_minute'], ['schedule-day', 'schedule_day'], ['cron-expression', 'cron_expression'], ['name', 'name']],
    switches: [['clear', 'clear']],
  },
  workflows: { usage: 'shepherd workflows [--json]' },
  'run-workflow': { usage: 'shepherd run-workflow <id> [--json]', positional: 'id' },
  open: { usage: 'shepherd open <id> [--json]', positional: 'id' },
};

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const setPath = (obj, key, value) => {
  const [head, tail] = key.split('.');
  if (!tail) return { ...obj, [head]: value };
  return { ...obj, [head]: { ...(isRecord(obj[head]) ? obj[head] : {}), [tail]: value } };
};

// The value of a key from a flag (a string) or from the JSON input (any JSON type): { ok, value } or { ok: false, takes }.
function coerce(key, value) {
  const t = TYPES[key];
  if (t.kind === 'bool') {
    if (value === true || value === 'true') return { ok: true, value: true };
    if (value === false || value === 'false') return { ok: true, value: false };
    return { ok: false, takes: 'true or false' };
  }
  if (t.kind === 'int' || t.kind === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (!Number.isFinite(n)) return { ok: false, takes: 'a number' };
    if (t.kind === 'int' && (!Number.isInteger(n) || n < 1)) return { ok: false, takes: 'a whole number, 1 or more' };
    return { ok: true, value: n };
  }
  if (t.kind === 'enum') {
    if (typeof value === 'string' && t.values.includes(value)) return { ok: true, value };
    return { ok: false, takes: t.values.join('|') };
  }
  if (typeof value === 'string') return { ok: true, value };
  return { ok: false, takes: 'text' };
}

// Parses `shepherd <verb> …` into { verb, args, json, copilotHome }, or { error: [problem, fix] }. `readStdin` is read only for `--input -`.
export function parseAgentVerb(verb, rest, readStdin = () => fs.readFileSync(0, 'utf8')) {
  const spec = AGENT_VERBS[verb];
  const fix = spec.usage;
  const out = { verb, args: {}, json: false, copilotHome: path.join(os.homedir(), '.copilot') };
  const flags = {};
  let positional;
  let input;
  const valueFlags = new Map(spec.options ?? []);
  const switchFlags = new Map(spec.switches ?? []);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') out.json = true;
    else if (a === '--input') {
      if (rest[i + 1] !== '-') return { error: ['--input takes - (a JSON object on stdin)', fix] };
      i++;
      try { input = readStdin(); } catch { return { error: ['--input - could not read stdin', fix] }; }
    } else if (a === '--copilot-home') {
      if (!rest[i + 1]) return { error: ['--copilot-home takes a folder', fix] };
      out.copilotHome = rest[++i];
    } else if (a.startsWith('--') && switchFlags.has(a.slice(2))) flags[switchFlags.get(a.slice(2))] = true;
    else if (a.startsWith('--') && valueFlags.has(a.slice(2))) {
      if (rest[i + 1] === undefined) return { error: [`${a} needs a value`, fix] };
      const key = valueFlags.get(a.slice(2));
      const c = coerce(key, rest[++i]);
      if (!c.ok) return { error: [`--${a.slice(2)} takes ${c.takes}`, fix] };
      flags[key] = c.value;
    } else if (!a.startsWith('--') && spec.positional && positional === undefined) positional = a;
    else return { error: [`unknown argument "${a}" for ${verb}`, fix] };
  }
  if (input !== undefined) {
    let parsed;
    try { parsed = JSON.parse(input); } catch { return { error: ['--input - needs one JSON object on stdin', fix] }; }
    if (!isRecord(parsed)) return { error: ['--input - needs one JSON object on stdin', fix] };
    const allowed = new Set(['kickoff', spec.positional, ...(spec.options ?? []).map(([, k]) => k), ...(spec.switches ?? []).map(([, k]) => k)].filter(Boolean));
    for (const [key, value] of Object.entries(parsed)) {
      if (!allowed.has(key)) return { error: [`unknown input key "${key}" for ${verb}`, fix] };
      if (key === 'kickoff') {
        if (!isRecord(value) || Object.keys(value).some((k) => !KICKOFF_KEYS.includes(k))) return { error: ['kickoff takes an object with prompt, mode, model, agent, reasoning_effort or permission_mode', fix] };
        for (const [k, v] of Object.entries(value)) {
          const c = coerce(`kickoff.${k}`, v);
          if (!c.ok) return { error: [`kickoff.${k} takes ${c.takes}`, fix] };
          out.args = setPath(out.args, `kickoff.${k}`, c.value);
        }
        continue;
      }
      const c = coerce(key, value);
      if (!c.ok) return { error: [`${key} takes ${c.takes}`, fix] };
      out.args[key] = c.value;
    }
  }
  if (positional !== undefined) out.args[spec.positional] = positional;
  for (const [key, value] of Object.entries(flags)) out.args = setPath(out.args, key, value);
  if (spec.positional && out.args[spec.positional] === undefined) return { error: [`${verb} needs ${spec.positional === 'id' ? 'an id' : 'a session id'}`, fix] };
  for (const key of spec.required ?? []) if (out.args[key] === undefined) return { error: [`${verb} needs --${key}`, fix] };
  return out;
}

const AUTOMATION_WRITE = (args) => args.clear === true || AUTOMATION_KEYS.some((k) => args[k] !== undefined);

// Runs one verb's operation. Returns the result object; the caller prints it.
export function runOperation(verb, args, d) {
  switch (verb) {
    case 'sessions': return sessions(d, { state: args.state });
    case 'session': return session(d, args.session_id);
    case 'messages': return messages(d, args.session_id, args.count ?? 6);
    case 'send': return send(d, args);
    case 'create': return create(d, args);
    case 'answer': return answer(d, args);
    case 'plan': return plan(d, args);
    case 'archive': return archiveSession(d, args);
    case 'automation': return AUTOMATION_WRITE(args) ? automation(d, args) : automationOf(d, args.session_id);
    case 'workflows': return workflows(d);
    case 'run-workflow': return runWorkflow(d, args.id);
    case 'open': return show(d, args.id);
    default: throw new ShepherdError({ code: 'unknown-verb', problem: `no operation for ${verb}`, fix: 'shepherd help' });
  }
}

// The text form: one line per session or message, otherwise the result as indented JSON.
export function renderText(verb, result) {
  if (verb === 'sessions') return result.sessions.map((s) => `${s.id.slice(0, 8)}  ${s.name}  ${s.activity.status} (${s.activity.why})`).join('\n') || 'no sessions';
  if (verb === 'session') return `${result.id.slice(0, 8)}  ${result.name}  ${result.activity.status} (${result.activity.why})`;
  if (verb === 'messages') return result.messages.map((m) => `${m.role}: ${m.text}`).join('\n') || 'no messages';
  return JSON.stringify(result, null, 2);
}

// Runs a parsed verb: prints its result (JSON with --json, text otherwise) and returns the exit code (0 ok, 1 not ok). A
// ShepherdError is printed as JSON too when --json is set, and then rethrown for the CLI's own error line.
export async function runAgent({ verb, args, json, copilotHome }, { out = (s) => process.stdout.write(s) } = {}) {
  const d = deps({ copilotHome });
  let result;
  try {
    result = await runOperation(verb, args, d);
  } catch (e) {
    if (json && e instanceof ShepherdError) out(`${JSON.stringify({ ok: false, code: e.code, error: e.message })}\n`);
    throw e;
  }
  const failed = result.ok === false || result.created === false;
  out(json ? `${JSON.stringify(result)}\n` : `${renderText(verb, result)}\n`);
  return failed ? 1 : 0;
}

