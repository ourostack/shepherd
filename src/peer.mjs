// Ouroboros' voice in the app: a message to a session goes out as a peer message from a durable app session named "Ouroboros", the
// way one session messages another, never as a prompt the app shows as the owner's own. The app's socket has no frame for a
// peer message (its send_session_message is a tool a session's agent calls), so that chat's agent makes the call: Shepherd
// asks it to, then reads its history to see that the call went out with exactly the text it was given.
import { ShepherdError } from './error.mjs';
import { formatForApp } from './format.mjs';
import { readJson, statePath, writeJson } from './store.mjs';

export const IDENTITY_NAME = 'Ouroboros';
export const IDENTITY_MODEL = 'claude-haiku-4.5';
export const IDENTITY_PROJECT = 'ourostack/shepherd';
export const identityProject = (env = process.env) => env.SHEPHERD_IDENTITY_PROJECT || IDENTITY_PROJECT;
export const RELAY_WAIT_MS = 120000;
const POLL_MS = 1000;
const TOOL = 'send_session_message';
const identityFile = (d) => statePath(d, 'identity');
const same = (got, want) => isRecord(got) && Object.keys(got).length === Object.keys(want).length && Object.keys(want).every((k) => got[k] === want[k]);
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// The relay request the identity session's agent is given: its one tool call, as JSON, and the rule to change nothing.
export const relayRequest = (args) => `Relay request. Call the ${TOOL} tool exactly once with these arguments, then reply "sent". Pass exactly these three arguments and no others (never source_user_message), with every value exactly as written here (JSON-decode the message text), and change, add or drop nothing.\n${JSON.stringify(args)}`;

// The relay's tool arguments for a send: the target, how to deliver, and the message formatted for the app's markdown.
export const relayArgs = (id, message, mode) => ({ session_id: id, delivery_mode: mode, message: formatForApp(message) });

// The identity session: the stored one while the app still lists it, else a new session named Ouroboros (which is stored).
export async function identity(d, { rows, create }) {
  const stored = readJson(identityFile(d), {}).session_id;
  const listed = await rows(d);
  if (typeof stored === 'string' && listed.some((r) => r.id === stored)) return { id: stored, name: IDENTITY_NAME };
  // A chat shows to its peers as "General Chat" whatever its title; a project session shows under its name.
  const made = await create(d, { name: IDENTITY_NAME, project_id: identityProject(), workspace_type: 'branch', kickoff: { model: IDENTITY_MODEL } });
  if (!made.ok || !made.session_id) throw new ShepherdError({ code: 'no-identity', problem: `the app would not make Ouroboros' own session (${made.error ?? 'no reason given'})`, fix: 'open the GitHub Copilot app, let it finish starting, and try again' });
  writeJson(identityFile(d), { session_id: made.session_id, name: IDENTITY_NAME, at: new Date(d.now()).toISOString() });
  return { id: made.session_id, name: IDENTITY_NAME };
}

// What the identity session did with the request: the tool call it made after `since` with these arguments, and how it ended.
export function relayOutcome(lines, args, since) {
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(isRecord);
  const calls = parsed.filter((e) => e.type === 'tool.execution_start' && e.data?.toolName === TOOL && Date.parse(e.timestamp) >= since);
  const exact = calls.filter((e) => same(e.data.arguments, args));
  if (!exact.length) return calls.length ? { state: 'altered', error: `the relay called ${TOOL} with text or arguments other than it was given; nothing is known to have reached the session` } : { state: 'pending' };
  const ends = exact.map((c) => parsed.find((e) => e.type === 'tool.execution_complete' && e.data?.toolCallId === c.data.toolCallId));
  if (ends.some((e) => e && e.data.success !== false)) return { state: 'sent' };
  if (ends.every(Boolean)) { const e = ends.at(-1).data; return { state: 'failed', error: String(e.error?.message ?? e.result?.content ?? 'the app refused the message').slice(0, 200) }; }
  return { state: 'pending' };
}

// Sends `message` to session `id` as a peer message from Ouroboros. Resolves { ok, from, from_session_id, message, error }.
export async function sendAsPeer(d, id, message, mode, { rows, create, deliver }) {
  const from = await identity(d, { rows, create });
  const args = relayArgs(id, message, mode);
  const since = d.now() - 2000;
  const asked = await deliver(d, from.id, relayRequest(args), 'immediate');
  const base = { from: from.name, from_session_id: from.id, message: args.message };
  if (!asked.ok) return { ok: false, ...base, error: `Ouroboros' own chat did not confirm the relay request: ${asked.error}` };
  const deadline = d.now() + (d.relayWaitMs ?? RELAY_WAIT_MS);
  for (;;) {
    const outcome = relayOutcome(d.history(from.id).lines, args, since);
    if (outcome.state === 'sent') return { ok: true, ...base, error: null };
    if (outcome.state === 'failed' || outcome.state === 'altered') return { ok: false, ...base, error: outcome.error };
    if (d.now() >= deadline) return { ok: false, ...base, error: `the relay had not sent the message within ${Math.round((d.relayWaitMs ?? RELAY_WAIT_MS) / 1000)} s; read Ouroboros' chat (${from.id}) before sending it again` };
    await d.sleep(d.pollMs ?? POLL_MS);
  }
}
