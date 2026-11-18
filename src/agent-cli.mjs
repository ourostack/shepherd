// The agent verbs of `shepherd`, as Ouro AX commands: each takes flags, or one JSON object on stdin (`--input -`), runs one
// operation from operate.mjs and returns its result. With --json the result is one line of JSON (on a refusal too, with ok
// false); without it, a short text. Keys in the JSON input are the tool arguments the operations take (session_id,
// delivery_mode, kickoff: { prompt, mode, … }); flags are their kebab-case names, and a flag wins over the input. A message to
// a session goes as a peer message from Ouroboros; --as-user sends the owner's own relayed words as a labelled user prompt.
import { defineCommand } from '../lib/ouro-ui/registry/ouro/ax/command.ts';
import { AxError, errorLine } from '../lib/ouro-ui/registry/ouro/ax/problem.ts';
import { outcome } from '../lib/ouro-ui/registry/ouro/ax/outcome.ts';
import { deps } from './sessions.mjs';
import { SESSION_STATES, runOperation } from './operate.mjs';

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
const AS_USER = ['as-user', 'as_user', "Send the owner's own relayed words, labelled, as a user prompt instead of a peer message."];
const AUDIENCE = 'the session it names and whoever reads it in the app';
const NAME = ['name', 'name', 'The title.'];

// Each verb: what it does, whether it only reads, the positional argument's tool key (if any), its value flags
// [flag, key, description] and its switches [flag, key, description].
export const AGENT_VERBS = {
  sessions: { summary: 'Every session in the sidebar: a summary and each session\'s activity.', read: true, options: [['state', 'state', 'Keep only the sessions in this state.']] },
  session: { summary: 'One session, with what it waits on (awaiting_input).', read: true, positional: 'session_id' },
  messages: { summary: 'A session\'s last messages, oldest first.', read: true, positional: 'session_id', options: [['count', 'count', 'How many messages: 6 by default.']] },
  send: {
    summary: 'Send a message to a session, as a peer message from Ouroboros\' own chat.', positional: 'session_id',
    options: [['message', 'message', 'The text to send.'], ['delivery', 'delivery_mode', 'immediate, or enqueue behind what the session is doing.']], switches: [AS_USER],
  },
  create: {
    summary: 'Make a session on a project (or a chat), optionally with a kickoff prompt.',
    options: [['project', 'project_id', 'The project, by id or name.'], ['session-kind', 'session_kind', 'chat, for a session with no project.'], NAME, ['workspace-type', 'workspace_type', 'worktree or branch.'], ['branch', 'branch_name', 'The branch to work on.'], ['prompt', 'kickoff.prompt', 'The first prompt.'], ['mode', 'kickoff.mode', 'How the session runs its first prompt.'], ['model', 'kickoff.model', 'The model.'], ['agent', 'kickoff.agent', 'The agent.'], ['reasoning-effort', 'kickoff.reasoning_effort', 'The reasoning effort.'], ['permission-mode', 'kickoff.permission_mode', 'allow-all or manual.']],
    switches: [AS_USER],
  },
  answer: { summary: 'Answer a question this watch heard the session ask.', positional: 'session_id', options: [['answer', 'answer', 'The answer.']] },
  plan: {
    summary: 'Approve or reject a plan this watch heard a session offer.', positional: 'session_id', required: ['approved'],
    options: [['approved', 'approved', 'true to approve, false to reject.'], ['action', 'selected_action', 'The option to take, when the plan offers several.'], ['feedback', 'feedback', 'What to tell the session.']], switches: [AS_USER],
  },
  archive: { summary: 'Archive a session this agent created, or one the owner asked to archive.', positional: 'session_id', switches: [['owner-asked', 'owner_asked', 'The owner asked for this archive, so a session this agent did not create may go.']] },
  automation: {
    summary: 'A session\'s automations (no fields), replace one, or clear it.', positional: 'session_id',
    options: [['prompt', 'prompt', 'What the automation sends.'], ['interval', 'interval', 'once, minutes, daily, weekly or cron.'], ['run-at', 'run_at', 'When a once automation runs.'], ['every-minutes', 'every_minutes', 'The gap for a minutes automation.'], ['schedule-hour', 'schedule_hour', 'The hour for a daily or weekly automation.'], ['schedule-minute', 'schedule_minute', 'The minute.'], ['schedule-day', 'schedule_day', 'The day for a weekly automation.'], ['cron-expression', 'cron_expression', 'The expression for a cron automation.'], NAME],
    switches: [['clear', 'clear', 'Remove the session\'s automation.']],
  },
  workflows: { summary: 'The app\'s workflows.', read: true },
  'run-workflow': { summary: 'Run one workflow now.', positional: 'id' },
  open: { summary: 'Show a session in the app\'s window.', read: true, positional: 'id' },
};

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const setPath = (obj, key, value) => {
  const [head, tail] = key.split('.');
  if (!tail) return { ...obj, [head]: value };
  return { ...obj, [head]: { ...(isRecord(obj[head]) ? obj[head] : {}), [tail]: value } };
};

// The value of a key from a flag or from the JSON input (any JSON type): { ok, value } or { ok: false, takes }.
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

const flagSpec = (key, description) => {
  const t = TYPES[key];
  if (t.kind === 'enum') return { type: 'enum', values: t.values, description };
  if (t.kind === 'bool') return { type: 'enum', values: ['true', 'false'], description };
  if (t.kind === 'int') return { type: 'number', min: 1, description };
  if (t.kind === 'number') return { type: 'number', description };
  return { type: 'string', description };
};

// The tool arguments of a verb's call: the JSON input (read from stdin by the kit) first, then the positional, then the flags.
export function toolArgs(verb, input) {
  const spec = AGENT_VERBS[verb];
  const bad = (problem) => new AxError({ code: 'bad-input', exit: 2, thing: verb, problem, fix: `shepherd ${verb} --help` });
  let args = {};
  if (input.input !== undefined) {
    let parsed;
    try { parsed = JSON.parse(input.input); } catch { throw bad('--input needs one JSON object on stdin'); }
    if (!isRecord(parsed)) throw bad('--input needs one JSON object on stdin');
    const allowed = new Set(['kickoff', spec.positional, ...(spec.options ?? []).map(([, k]) => k), ...(spec.switches ?? []).map(([, k]) => k)].filter(Boolean));
    for (const [key, value] of Object.entries(parsed)) {
      if (!allowed.has(key)) throw bad(`unknown input key "${key}" for ${verb}`);
      if (key !== 'kickoff') {
        const c = coerce(key, value);
        if (!c.ok) throw bad(`${key} takes ${c.takes}`);
        args[key] = c.value;
        continue;
      }
      if (!isRecord(value) || Object.keys(value).some((k) => !KICKOFF_KEYS.includes(k))) throw bad('kickoff takes an object with prompt, mode, model, agent, reasoning_effort or permission_mode');
      for (const [k, v] of Object.entries(value)) {
        const c = coerce(`kickoff.${k}`, v);
        if (!c.ok) throw bad(`kickoff.${k} takes ${c.takes}`);
        args = setPath(args, `kickoff.${k}`, c.value);
      }
    }
  }
  if (input.id !== undefined) args[spec.positional] = input.id;
  for (const [flag, key] of [...(spec.options ?? []), ...(spec.switches ?? [])]) {
    if (input[flag] === undefined) continue;
    const c = coerce(key, input[flag]);
    if (!c.ok) throw bad(`--${flag} takes ${c.takes}`);
    args = setPath(args, key, c.value);
  }
  return args;
}

// The text form: one line per session or message, otherwise the result as indented JSON.
export function renderText(verb, result) {
  if (result.note && result.followed_from && verb === 'send') return `${result.note}\n${JSON.stringify(result, null, 2)}`;
  if (verb === 'sessions' && result.sessions) return result.sessions.map((s) => `${s.id.slice(0, 8)}  ${s.name}  ${s.activity.status} (${s.activity.why})`).join('\n') || 'no sessions';
  if (verb === 'session' && result.id) return `${result.id.slice(0, 8)}  ${result.name}  ${result.activity.status} (${result.activity.why})`;
  if (verb === 'messages' && result.messages) return result.messages.map((m) => `${m.role}: ${m.text}`).join('\n') || 'no messages';
  return JSON.stringify(result, null, 2);
}

const failed = (r) => r.ok === false || r.created === false;

// Temporary soft mode: a missing --why warns instead of refusing, until the callers that need it have landed. SHEPHERD_STRICT_WHY=1 refuses.
const strictWhy = () => ['1', 'true'].includes(process.env.SHEPHERD_STRICT_WHY ?? '');

// The kit commands of the agent verbs. `guard` turns a library error into the kit's; `copilotHome` reads the --copilot-home flag.
export function agentCommands({ guard, copilotHome }) {
  return Object.entries(AGENT_VERBS).map(([verb, spec]) => {
    const required = spec.required ?? [];
    const flags = {
      ...Object.fromEntries((spec.options ?? []).map(([flag, key, description]) => [flag, { ...flagSpec(key, description), ...(required.includes(key) ? { required: true, unless: 'input' } : {}) }])),
      ...Object.fromEntries((spec.switches ?? []).map(([flag, , description]) => [flag, { type: 'boolean', description }])),
      input: { type: 'string', stdin: true, placeholder: '<json>', description: 'One JSON object instead of flags: the tool arguments, such as session_id, as its keys; "-" reads it from stdin. A flag wins over it.' },
    };
    return defineCommand({
      name: verb,
      summary: spec.summary,
      effect: spec.read ? 'private' : 'others',
      ...(spec.read ? {} : { why: strictWhy() ? 'required' : 'optional' }),
      args: spec.positional ? [{ name: 'id', source: spec.positional === 'session_id' ? 'sessions' : spec.summary.startsWith('Run') ? 'workflows' : 'sessions', description: spec.positional === 'session_id' ? 'The session: its whole id, or the first 8 or more characters of it.' : 'The id, as shepherd lists it.' }] : [],
      flags,
      output: '{ ok, … } as the operation answers; { ok: false, code, error } with the reason when the app refused or did not answer',
      exit: (r) => (failed(r) ? 'error' : 'ok'),
      text: (r) => renderText(verb, r),
      plan: (input) => outcome({
        action: verb,
        state: 'planned',
        effect: 'others',
        audience: { only: false, who: AUDIENCE },
        summary: `Would run shepherd ${verb}${input.id ? ` on ${input.id}` : ''}: ${spec.summary} Nothing was sent. ${AUDIENCE[0].toUpperCase()}${AUDIENCE.slice(1)} will see it.`,
      }),
      async run(input, ctx) {
        if (!spec.read && !strictWhy() && !input.why) process.stderr.write(`shepherd: warning: ${verb} was run without --why; a later release will refuse it. Add --why "who asked and what they said".\n`);
        const args = toolArgs(verb, input);
        // Checked here, after --why, so a call without both is told about --why first.
        if (spec.positional && args[spec.positional] === undefined) {
          const source = spec.positional === 'session_id' ? 'sessions' : 'workflows';
          throw new AxError({ code: 'missing-arg', exit: 2, thing: verb, problem: `needs <id> (or --input with ${spec.positional})`, fix: `shepherd ${source}, then shepherd ${verb} <id>` });
        }
        try {
          return await guard(verb, () => runOperation(verb, args, deps({ copilotHome: copilotHome(input) })));
        } catch (e) {
          // A caller reads `{ ok: false, code, error }` from the last line of stdout; the error line still goes to stderr.
          if (ctx?.json && e instanceof AxError && e.exit === 1) {
            process.stderr.write(`${errorLine('shepherd', e.shape)}\n`);
            return { ok: false, code: e.shape.code, error: e.message.slice(e.shape.thing.length + 2) };
          }
          throw e;
        }
      },
    });
  });
}
