#!/usr/bin/env node
// `shepherd status [--json]` reads the app's sessions; `shepherd restore-history <id>` puts back a compressed history;
// `shepherd help`. Only restore-history writes, and only inside the session's own history folder.
// Exit codes: 0 ok, 1 the app's data could not be read, 2 usage.
import os from 'node:os';
import path from 'node:path';
import { ShepherdError, deps, restoreHistory, snapshot } from '../src/index.mjs';

const USAGE = `shepherd: keeps the flock: the GitHub Copilot app's sessions, as work.

  shepherd status [--json] [--copilot-home <dir>]   each local session: short id, title, busy or idle and why, history size
  shepherd restore-history <id> [--json]           put back an archived session's compressed history
  shepherd help                                    this text

Exit codes: 0 ok, 1 the app's data could not be read or the history could not be restored, 2 usage.`;

const usage = (problem, fix) => {
  process.stderr.write(`shepherd: usage: ${problem}. Fix: ${fix}.\n`);
  process.exitCode = 2;
};

function parse(argv) {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') return { verb: 'help' };
  if (verb !== 'status' && verb !== 'restore-history') return { error: [`unknown command "${verb}"`, 'shepherd help'] };
  const opts = { json: false, id: null, copilotHome: path.join(os.homedir(), '.copilot') };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--copilot-home' && rest[i + 1]) opts.copilotHome = rest[++i];
    else if (verb === 'restore-history' && opts.id === null && !a.startsWith('--')) opts.id = a;
    else return { error: [`unknown flag "${a}"`, 'shepherd help'] };
  }
  if (verb === 'restore-history' && opts.id === null) return { error: ['restore-history needs a session id', 'shepherd restore-history <id>'] };
  return { verb, opts };
}

async function status({ json, copilotHome }) {
  const d = deps({ copilotHome });
  const sessions = (await snapshot(d)).map((s) => ({
    id: s.id,
    title: s.title,
    mode: s.mode,
    state: s.state,
    why: s.why,
    history_mb: Math.round((d.historySize(s.id) / 1048576) * 10) / 10,
  }));
  if (json) {
    process.stdout.write(`${JSON.stringify({ sessions })}\n`);
    return;
  }
  if (!sessions.length) process.stdout.write(`no local sessions in ${copilotHome}\n`);
  for (const s of sessions) process.stdout.write(`${s.id.slice(0, 8)}  ${s.title || '(untitled)'}  ${s.state} (${s.why})  ${s.history_mb.toFixed(1)} MB\n`);
}

async function restore({ id, json, copilotHome }) {
  const r = await restoreHistory(deps({ copilotHome }), id);
  if (json) process.stdout.write(`${JSON.stringify(r)}\n`);
  else if (!r.ok) process.stderr.write(`shepherd: restore-history: ${r.why}\n`);
  else process.stdout.write(`${r.restored ? 'restored' : 'nothing to restore for'} ${id}${r.why ? `: ${r.why}` : ''}\n`);
  if (!r.ok) process.exitCode = 1;
}

const parsed = parse(process.argv.slice(2));
if (parsed.error) usage(...parsed.error);
else if (parsed.verb === 'help') process.stdout.write(`${USAGE}\n`);
else {
  try {
    if (parsed.verb === 'status') await status(parsed.opts);
    else await restore(parsed.opts);
  } catch (e) {
    if (e instanceof ShepherdError) process.stderr.write(`shepherd: ${e.code}: ${e.message}\n`);
    else process.stderr.write(`shepherd: error: ${e.message}. Fix: run shepherd status again, and file an issue if it repeats.\n`);
    process.exitCode = 1;
  }
}
