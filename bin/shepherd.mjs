#!/usr/bin/env node
// `shepherd status [--json]` reads the app's sessions; `shepherd restore-history <id>` puts back a compressed history;
// `shepherd watch` is one pass of the health watch (--status shows it); `shepherd install` loads the launch agent that runs
// the watch every minute; `shepherd help`. Only restore-history writes inside a session's history folder; watch writes
// its own state folder; install writes the launch agent (--dry-run writes nothing).
// Exit codes: 0 ok, 1 the app's data could not be read, a history could not be restored, or the agent could not load, 2 usage.
import os from 'node:os';
import path from 'node:path';
import { ShepherdError, deps, restoreHistory, snapshot, stateDir } from '../src/index.mjs';
import { counts, healthDeps, pass, readWatch, renderWatch } from '../src/health-watch.mjs';
import { install } from '../src/install.mjs';

const USAGE = `shepherd: keeps the flock: the GitHub Copilot app's sessions, as work.

  shepherd status [--json] [--copilot-home <dir>]   each local session: short id, title, busy or idle and why, history size
  shepherd restore-history <id> [--json]           put back an archived session's compressed history
  shepherd watch [--quiet] [--json]                one pass of the health watch over the resumed sessions, then exit
  shepherd watch --status [--json]                 what the health watch is following: healthy, waiting, asked again, broken
  shepherd install [--dry-run]                     load the launch agent that runs "watch --quiet" every 60 s (--dry-run prints it)
  shepherd help                                    this text

Exit codes: 0 ok, 1 the app's data could not be read, the history could not be restored, or the agent could not load, 2 usage.`;

const FLAGS = {
  status: ['json', 'copilot-home'],
  'restore-history': ['json', 'copilot-home', 'id'],
  watch: ['json', 'quiet', 'status', 'copilot-home'],
  install: ['dry-run'],
};

const usage = (problem, fix) => {
  process.stderr.write(`shepherd: usage: ${problem}. Fix: ${fix}.\n`);
  process.exitCode = 2;
};

function parse(argv) {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') return { verb: 'help' };
  if (!FLAGS[verb]) return { error: [`unknown command "${verb}"`, 'shepherd help'] };
  const allowed = (flag) => FLAGS[verb].includes(flag);
  const opts = { json: false, quiet: false, status: false, dryRun: false, id: null, copilotHome: path.join(os.homedir(), '.copilot') };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json' && allowed('json')) opts.json = true;
    else if (a === '--quiet' && allowed('quiet')) opts.quiet = true;
    else if (a === '--status' && allowed('status')) opts.status = true;
    else if (a === '--dry-run' && allowed('dry-run')) opts.dryRun = true;
    else if (a === '--copilot-home' && allowed('copilot-home') && rest[i + 1]) opts.copilotHome = rest[++i];
    else if (allowed('id') && opts.id === null && !a.startsWith('--')) opts.id = a;
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

async function watch({ json, quiet, status, copilotHome }) {
  if (status) {
    const r = readWatch(stateDir());
    if (json) process.stdout.write(`${JSON.stringify({ ...r, counts: r.watch ? counts(r.watch) : null })}\n`);
    else process.stdout.write(`${renderWatch(r)}\n`);
    return;
  }
  const r = await pass({}, healthDeps({ copilotHome }), (line) => { if (!quiet) process.stdout.write(`${line}\n`); });
  if (json) process.stdout.write(`${JSON.stringify({ action: r.action, counts: r.counts ?? null })}\n`);
  else if (!quiet && r.action === 'none') process.stdout.write('health watch: nothing to follow yet\n');
}

async function installAgent({ dryRun }) {
  const r = await install({ dry: dryRun });
  if (dryRun) { process.stdout.write(r.text); return; }
  if (!r.ok) {
    process.stderr.write(`shepherd: install: launchctl could not load ${r.label}: ${r.error || 'no reason given'}. Fix: check ${r.plist}, then run shepherd install again while logged in to this Mac.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`installed ${r.label}: ${r.plist}; logs in ${r.log}\n`);
}

const parsed = parse(process.argv.slice(2));
if (parsed.error) usage(...parsed.error);
else if (parsed.verb === 'help') process.stdout.write(`${USAGE}\n`);
else {
  try {
    if (parsed.verb === 'status') await status(parsed.opts);
    else if (parsed.verb === 'watch') await watch(parsed.opts);
    else if (parsed.verb === 'install') await installAgent(parsed.opts);
    else await restore(parsed.opts);
  } catch (e) {
    if (e instanceof ShepherdError) process.stderr.write(`shepherd: ${e.code}: ${e.message}\n`);
    else process.stderr.write(`shepherd: error: ${e.message}. Fix: run shepherd status again, and file an issue if it repeats.\n`);
    process.exitCode = 1;
  }
}
