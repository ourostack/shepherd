#!/usr/bin/env node
// `shepherd status [--json]` reads the app's sessions; `shepherd help`. Read-only: nothing is sent to the app or written.
// Exit codes: 0 ok, 1 the app's data could not be read, 2 usage.
import os from 'node:os';
import path from 'node:path';
import { ShepherdError, deps, snapshot } from '../src/index.mjs';

const USAGE = `shepherd: keeps the flock: the GitHub Copilot app's sessions, as work.

  shepherd status [--json] [--copilot-home <dir>]   each local session: short id, title, busy or idle and why, history size
  shepherd help                                      this text

Read-only. Exit codes: 0 ok, 1 the app's data could not be read, 2 usage.`;

const usage = (problem, fix) => {
  process.stderr.write(`shepherd: usage: ${problem}. Fix: ${fix}.\n`);
  process.exitCode = 2;
};

function parse(argv) {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') return { verb: 'help' };
  if (verb !== 'status') return { error: [`unknown command "${verb}"`, 'shepherd help'] };
  const opts = { json: false, copilotHome: path.join(os.homedir(), '.copilot') };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') opts.json = true;
    else if (a === '--copilot-home' && rest[i + 1]) opts.copilotHome = rest[++i];
    else return { error: [`unknown flag "${a}"`, 'shepherd help'] };
  }
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

const parsed = parse(process.argv.slice(2));
if (parsed.error) usage(...parsed.error);
else if (parsed.verb === 'help') process.stdout.write(`${USAGE}\n`);
else {
  try {
    await status(parsed.opts);
  } catch (e) {
    if (e instanceof ShepherdError) process.stderr.write(`shepherd: ${e.code}: ${e.message}\n`);
    else process.stderr.write(`shepherd: error: ${e.message}. Fix: run shepherd status again, and file an issue if it repeats.\n`);
    process.exitCode = 1;
  }
}
