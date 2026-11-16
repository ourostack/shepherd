#!/usr/bin/env node
// `shepherd status [--json]` reads the app's sessions; `shepherd restore-history <id>` puts back a compressed history;
// `shepherd watch` is one pass of the health watch (--every keeps it resident, with the quota balancer; --status shows it);
// `shepherd quota` reads and plans the Copilot quota balancer (status shows its last tick); `shepherd sidebar` plans or applies
// the sidebar tidy; `shepherd install` loads the launch agent that keeps `watch --every 60` running; `shepherd help`. Only
// restore-history writes inside a session's history folder; watch and quota write their own state folders; sidebar apply asks
// the app to show or hide projects; install writes the launch agent (--dry-run writes nothing).
// Exit codes: 0 ok, 1 the app's data could not be read, a history could not be restored, the agent could not load, or the app
// refused a sidebar change, 2 usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShepherdError, deps, quotaConfig, quotaRead, quotaStatus, quotaTick, restoreHistory, sidebarConfig, sidebarFile, sidebarTidy, renderSidebar, snapshot, stateDir } from '../src/index.mjs';
import { counts, healthDeps, pass, readWatch, renderWatch } from '../src/health-watch.mjs';
import { install } from '../src/install.mjs';
import { renderQuota, renderReadings } from '../src/quota.mjs';
import { runResident, watchDuties } from '../src/resident.mjs';

const USAGE = `shepherd: keeps the flock: the GitHub Copilot app's sessions, as work.

  shepherd status [--json] [--copilot-home <dir>]   each local session: short id, title, busy or idle and why, history size
  shepherd restore-history <id> [--json]           put back an archived session's compressed history
  shepherd watch [--quiet] [--json]                one pass of the health watch over the resumed sessions, then exit
  shepherd watch --every <seconds> [--quiet]       stay resident: each pass runs the health watch, then the quota balancer,
                                                   then the sidebar tidy (at most every everyMinutes)
  shepherd watch --status [--json]                 what the health watch is following: healthy, waiting, asked again, broken
  shepherd quota [read|plan|status] [--json]       each account's premium-request quota; plan: what a tick would do now;
                                                   status: the last tick (default)
  shepherd sidebar [plan|apply] [--json]           which projects the sidebar shows (a home, or a session); plan changes
                                                   nothing (default); apply needs sidebar.json to say "enabled": true
  shepherd install [--dry-run]                     load the launch agent that runs "watch --every 60 --quiet" (--dry-run prints it)
  shepherd version [--json]                        the installed version (also --version)
  shepherd help                                    this text

Exit codes: 0 ok, 1 the app's data could not be read, the history could not be restored, the agent could not load, or the app
refused a sidebar change, 2 usage.`;

const FLAGS = {
  status: ['json', 'copilot-home'],
  'restore-history': ['json', 'copilot-home', 'id'],
  watch: ['json', 'quiet', 'status', 'copilot-home', 'every'],
  quota: ['json', 'copilot-home', 'id'],
  sidebar: ['json', 'copilot-home', 'id'],
  install: ['dry-run'],
};

const QUOTA_SUBS = ['read', 'plan', 'status'];
const SIDEBAR_SUBS = ['plan', 'apply'];

const usage = (problem, fix) => {
  process.stderr.write(`shepherd: usage: ${problem}. Fix: ${fix}.\n`);
  process.exitCode = 2;
};

function parse(argv) {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') return { verb: 'help' };
  if (verb === 'version' || verb === '--version' || verb === '-v') return { verb: 'version', opts: { json: rest.includes('--json') } };
  if (!FLAGS[verb]) return { error: [`unknown command "${verb}"`, 'shepherd help'] };
  const allowed = (flag) => FLAGS[verb].includes(flag);
  const opts = { json: false, quiet: false, status: false, dryRun: false, every: null, id: null, copilotHome: path.join(os.homedir(), '.copilot') };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json' && allowed('json')) opts.json = true;
    else if (a === '--quiet' && allowed('quiet')) opts.quiet = true;
    else if (a === '--status' && allowed('status')) opts.status = true;
    else if (a === '--dry-run' && allowed('dry-run')) opts.dryRun = true;
    else if (a === '--every' && allowed('every') && rest[i + 1] !== undefined) {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 1) return { error: ['--every takes whole seconds, 1 or more', 'shepherd watch --every 60'] };
      opts.every = n;
    }
    else if (a === '--copilot-home' && allowed('copilot-home') && rest[i + 1]) opts.copilotHome = rest[++i];
    else if (allowed('id') && opts.id === null && !a.startsWith('--')) opts.id = a;
    else return { error: [`unknown flag "${a}"`, 'shepherd help'] };
  }
  if (verb === 'restore-history' && opts.id === null) return { error: ['restore-history needs a session id', 'shepherd restore-history <id>'] };
  if (verb === 'quota' && opts.id !== null && !QUOTA_SUBS.includes(opts.id)) return { error: [`quota takes read, plan or status, not "${opts.id}"`, 'shepherd quota status'] };
  if (verb === 'sidebar' && opts.id !== null && !SIDEBAR_SUBS.includes(opts.id)) return { error: [`sidebar takes plan or apply, not "${opts.id}"`, 'shepherd sidebar plan'] };
  if (verb === 'watch' && opts.every !== null && opts.status) return { error: ['--every and --status cannot be used together', 'shepherd watch --status'] };
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

async function watch({ json, quiet, status, copilotHome, every }) {
  if (status) {
    const r = readWatch(stateDir());
    if (json) process.stdout.write(`${JSON.stringify({ ...r, counts: r.watch ? counts(r.watch) : null })}\n`);
    else process.stdout.write(`${renderWatch(r)}\n`);
    return;
  }
  if (every) {
    const log = (line) => process.stderr.write(`${line}\n`);
    const say = (line) => process.stdout.write(`${line}\n`);
    await runResident({ everyMs: every * 1000, duties: watchDuties({ copilotHome, quiet, say, log }), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log });
    return;
  }
  const r = await pass({}, healthDeps({ copilotHome }), (line) => { if (!quiet) process.stdout.write(`${line}\n`); });
  if (json) process.stdout.write(`${JSON.stringify({ action: r.action, counts: r.counts ?? null })}\n`);
  else if (!quiet && r.action === 'none') process.stdout.write('health watch: nothing to follow yet\n');
}

async function quota({ id = 'status', json, copilotHome }) {
  if (id === 'status') {
    const last = quotaStatus();
    if (json) process.stdout.write(`${JSON.stringify(last)}\n`);
    else process.stdout.write(`${last ? renderQuota(last) : 'no quota tick has run yet'}\n`);
    return;
  }
  const cfg = quotaConfig();
  const d = deps({ copilotHome });
  if (id === 'read') {
    const r = await quotaRead(d, cfg);
    process.stdout.write(`${json ? JSON.stringify(r) : renderReadings(r)}\n`);
    return;
  }
  const out = await quotaTick(d, { apply: false, cfg });
  process.stdout.write(`${json ? JSON.stringify(out) : renderQuota(out)}\n`);
}

async function sidebar({ id, json, copilotHome }) {
  const sub = id ?? 'plan';
  const file = sidebarFile();
  const cfg = sidebarConfig(file);
  if (sub === 'apply' && !cfg.enabled) throw new ShepherdError({ code: 'sidebar-off', problem: `the sidebar tidy is off: ${file} does not say "enabled": true`, fix: `set "enabled": true and "homes" in ${file}, then run shepherd sidebar apply` });
  const out = await sidebarTidy(deps({ copilotHome }), { homes: cfg.homes, apply: sub === 'apply' });
  if (json) process.stdout.write(`${JSON.stringify({ ...out, enabled: cfg.enabled })}\n`);
  else process.stdout.write(`${renderSidebar(out, { enabled: cfg.enabled, file })}\n`);
  if (out.done.some((d) => !d.ok)) process.exitCode = 1;
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
else if (parsed.verb === 'version') {
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(parsed.opts.json ? `${JSON.stringify({ version })}\n` : `${version}\n`);
}
else {
  try {
    if (parsed.verb === 'status') await status(parsed.opts);
    else if (parsed.verb === 'watch') await watch(parsed.opts);
    else if (parsed.verb === 'install') await installAgent(parsed.opts);
    else if (parsed.verb === 'quota') await quota(parsed.opts);
    else if (parsed.verb === 'sidebar') await sidebar(parsed.opts);
    else await restore(parsed.opts);
  } catch (e) {
    if (e instanceof ShepherdError) process.stderr.write(`shepherd: ${e.code}: ${e.message}\n`);
    else process.stderr.write(`shepherd: error: ${e.message}. Fix: run shepherd status again, and file an issue if it repeats.\n`);
    process.exitCode = 1;
  }
}
