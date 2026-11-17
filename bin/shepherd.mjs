#!/usr/bin/env node
// `shepherd status [--json]` reads the app's sessions; `shepherd restore-history <id>` puts back a compressed history;
// `shepherd watch` is one pass of the health watch (--every keeps it resident, with the quota balancer; --status shows it);
// `shepherd quota` reads and plans the Copilot quota balancer (status shows its last tick); `shepherd sidebar` plans or applies
// the sidebar tidy; `shepherd retire` plans, or applies, the hand-off retirement and the size watch; `shepherd wakes` shows, or
// polls, the wake runners; `shepherd stuck` plans the stuck resume; `shepherd install` loads the launch agent that keeps
// `watch --every 60` running; `shepherd help`. Only restore-history writes inside a session's history folder; watch, quota,
// sidebar apply, retire apply and wakes poll write their own state folders; sidebar apply asks the app to show or hide
// projects; wakes poll sends wakes only when wakes.json enables them; install writes the launch agent (--dry-run writes
// nothing). Plans change nothing.
// Exit codes: 0 ok, 1 the app's data could not be read, a history could not be restored, the agent could not load, or the app
// refused a sidebar change, 2 usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShepherdError, deps, planWakes, quotaConfig, quotaRead, quotaStatus, quotaTick, readWakeStates, rows, restoreHistory, runWakeRunners, runnerDeps, sidebarConfig, sidebarFile, sidebarTidy, renderSidebar, snapshot, stateDir, stuckPlan, stuckResumeConfig, stuckResumeFile, trustAll, trustConfig, trustFile, untrusted, wakeStatusLines, wakesConfig, wakesFile } from '../src/index.mjs';
import { renderRetire, retireConfig, retireDeps, retireFile, watchRetire } from '../src/retire.mjs';
import { counts, healthDeps, pass, readWatch, renderWatch } from '../src/health-watch.mjs';
import { install } from '../src/install.mjs';
import { renderQuota, renderReadings } from '../src/quota.mjs';
import { runResident, watchDuties } from '../src/resident.mjs';
import { AGENT_VERBS, parseAgentVerb, runAgent } from '../src/agent-cli.mjs';

const USAGE = `shepherd: keeps the flock: the GitHub Copilot app's sessions, as work.

  shepherd status [--json] [--copilot-home <dir>]   each local session: short id, title, busy or idle and why, history size
  shepherd restore-history <id> [--json]           put back an archived session's compressed history
  shepherd watch [--quiet] [--json]                one pass of the health watch over the resumed sessions, then exit
  shepherd watch --every <seconds> [--quiet]       stay resident: each pass runs the health watch, then the quota balancer,
                                                   then the sidebar tidy (at most every everyMinutes), then the retire, wake
                                                   and stuck-resume duties (each only when its config enables it)
  shepherd watch --status [--json]                 what the health watch is following: healthy, waiting, asked again, broken
  shepherd quota [read|plan|status] [--json]       each account's premium-request quota; plan: what a tick would do now;
                                                   status: the last tick (default)
  shepherd sidebar [plan|apply] [--json]           which projects the sidebar shows (a home, or a session); plan changes
                                                   nothing (default); apply needs sidebar.json to say "enabled": true
  shepherd retire [plan|apply] [--json]            hand-off retirement and the size watch: plan (default) changes nothing;
                                                   apply archives, flags and asks, and only when retire.json enables it
  shepherd wakes [status|poll] [--json]            each wake runner's last run, wakes delivered, open wakes and status lines
                                                   (status, the default); poll runs each command now and sends its wakes only
                                                   when wakes.json says "enabled": true, otherwise it sends nothing
  shepherd stuck [plan] [--json]                   sessions whose loop stopped, and what a stuck resume would do (plan, the
                                                   default, changes nothing); the watch resumes them only when stuck-resume.json
                                                   says "enabled": true
  shepherd trust [plan|apply] [--json]             the local repository projects the app has not trusted (plan, the default, changes
                                                   nothing); apply trusts them. The watch does it each pass when trust.json says
                                                   "enabled": true
  shepherd install [--dry-run]                     load the launch agent that runs "watch --every 60 --quiet" (--dry-run prints it)
  shepherd version [--json]                        the installed version (also --version)
  shepherd help                                    this text

Agent verbs (each takes flags, or one JSON object on stdin with --input -; --json prints one JSON result):
  shepherd sessions [--state busy|idle|waiting|stuck] [--json]   every session in the sidebar: summary and per-session activity
  shepherd session <id> [--json]                    one session, with what it waits on (awaiting_input)
  shepherd messages <id> [--count <n>] [--json]     its last n messages (default 6), oldest first
  shepherd send <id> --message <text> [--delivery immediate|enqueue] [--json]
  shepherd create [--project <id|name> | --session-kind chat] [--name <title>] [--workspace-type worktree|branch]
                  [--branch <name>] [--prompt <text>] [--mode interactive|plan|autopilot] [--model <m>] [--agent <a>]
                  [--reasoning-effort <e>] [--permission-mode allow-all|manual] [--json]
  shepherd answer <id> --answer <text> [--json]     answer a question this watch heard the session ask
  shepherd plan <id> --approved true|false [--action <option>] [--feedback <text>] [--json]
  shepherd archive <id> [--owner-asked] [--json]    archive a session this agent created (or, with --owner-asked, one the owner asked for)
  shepherd automation <id> [--clear | --interval once|minutes|daily|weekly|cron --prompt <text> …] [--json]
                                                    its automations (no fields), replace one, or clear it
  shepherd workflows [--json]                       the app's workflows
  shepherd run-workflow <id> [--json]               run one now
  shepherd open <id> [--json]                       show a session in the app's window

Exit codes: 0 ok, 1 the app's data could not be read, the history could not be restored, the agent could not load, the app
refused a sidebar change, or an agent verb was refused or failed, 2 usage.`;

const FLAGS = {
  status: ['json', 'copilot-home'],
  'restore-history': ['json', 'copilot-home', 'id'],
  watch: ['json', 'quiet', 'status', 'copilot-home', 'every'],
  quota: ['json', 'copilot-home', 'id'],
  sidebar: ['json', 'copilot-home', 'id'],
  retire: ['json', 'copilot-home', 'id'],
  wakes: ['json', 'copilot-home', 'id'],
  stuck: ['json', 'copilot-home', 'id'],
  trust: ['json', 'copilot-home', 'id'],
  install: ['dry-run'],
};

const QUOTA_SUBS = ['read', 'plan', 'status'];
const SIDEBAR_SUBS = ['plan', 'apply'];
const RETIRE_SUBS = ['plan', 'apply'];
const WAKES_SUBS = ['status', 'poll'];
const STUCK_SUBS = ['plan'];
const TRUST_SUBS = ['plan', 'apply'];

const usage = (problem, fix) => {
  process.stderr.write(`shepherd: usage: ${problem}. Fix: ${fix}.\n`);
  process.exitCode = 2;
};

function parse(argv) {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === 'help' || verb === '--help' || verb === '-h') return { verb: 'help' };
  if (verb === 'version' || verb === '--version' || verb === '-v') return { verb: 'version', opts: { json: rest.includes('--json') } };
  if (AGENT_VERBS[verb]) {
    const agent = parseAgentVerb(verb, rest);
    return agent.error ? { error: agent.error } : { verb, agent };
  }
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
  if (verb === 'retire' && opts.id !== null && !RETIRE_SUBS.includes(opts.id)) return { error: [`retire takes plan or apply, not "${opts.id}"`, 'shepherd retire plan'] };
  if (verb === 'wakes' && opts.id !== null && !WAKES_SUBS.includes(opts.id)) return { error: [`wakes takes status or poll, not "${opts.id}"`, 'shepherd wakes status'] };
  if (verb === 'stuck' && opts.id !== null && !STUCK_SUBS.includes(opts.id)) return { error: [`stuck takes plan, not "${opts.id}"`, 'shepherd stuck plan'] };
  if (verb === 'trust' && opts.id !== null && !TRUST_SUBS.includes(opts.id)) return { error: [`trust takes plan or apply, not "${opts.id}"`, 'shepherd trust plan'] };
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

async function retire({ id, json, copilotHome }) {
  const sub = id ?? 'plan';
  const file = retireFile();
  if (sub === 'apply' && !retireConfig(file).enabled) {
    usage(`retire apply is off, because ${file} does not say "enabled": true`, `set "enabled": true in ${file}, or run shepherd retire plan`);
    return;
  }
  const r = await watchRetire(retireDeps({ copilotHome }), { apply: sub === 'apply' });
  if (json) process.stdout.write(`${JSON.stringify(r)}\n`);
  else process.stdout.write(`${renderRetire(r)}\n`);
  if (r.errors.length) process.exitCode = 1;
}

async function wakes({ id = 'status', json, copilotHome }) {
  const file = wakesFile();
  const cfg = wakesConfig(file);
  const d = deps({ copilotHome });
  const now = d.now();
  if (id === 'poll' && !cfg.enabled) {
    const plans = await planWakes(cfg.runners);
    if (json) { process.stdout.write(`${JSON.stringify({ enabled: false, file, plans })}\n`); return; }
    process.stdout.write(`wakes are off (${file} does not say "enabled": true): nothing was sent\n`);
    for (const p of plans) {
      if (p.error) process.stdout.write(`wake runner ${p.name}: ${p.error}\n`);
      else process.stdout.write(`wake runner ${p.name}: would send ${p.wakes.length} wake(s)\n${p.wakes.map((w) => `  ${w.session ?? 'no session'}: ${w.message.slice(0, 80)}`).join('\n')}${p.wakes.length ? '\n' : ''}`);
    }
    return;
  }
  const states = id === 'poll' ? await runWakeRunners(d.state, cfg.runners, runnerDeps(d, now)) : readWakeStates(d.state);
  if (json) { process.stdout.write(`${JSON.stringify({ enabled: cfg.enabled, file, runners: cfg.runners.map((r) => ({ name: r.name, state: states[r.name] ?? null })) })}\n`); return; }
  if (!cfg.enabled) process.stdout.write(`wakes are off: ${file} does not say "enabled": true\n`);
  if (!cfg.runners.length) process.stdout.write(`no wake runners in ${file}\n`);
  for (const line of wakeStatusLines(cfg.runners, states, now)) process.stdout.write(`${line}\n`);
}

async function stuck({ json, copilotHome }) {
  const file = stuckResumeFile();
  const enabled = stuckResumeConfig(file).enabled;
  const d = deps({ copilotHome });
  const sessions = stuckPlan(await rows(d), d);
  if (json) { process.stdout.write(`${JSON.stringify({ enabled, file, sessions })}\n`); return; }
  if (!enabled) process.stdout.write(`stuck resume is off: ${file} does not say "enabled": true\n`);
  if (!sessions.length) process.stdout.write('no stuck sessions\n');
  for (const s of sessions) process.stdout.write(`${s.resume ? 'would resume' : 'would leave'}  ${s.id.slice(0, 8)}  ${s.name}  (${s.why})\n`);
}

async function trust({ json, copilotHome, id: sub }) {
  const file = trustFile();
  const enabled = trustConfig(file).enabled;
  const d = deps({ copilotHome });
  const r = sub === 'apply' ? await trustAll(d) : { trusted: await untrusted(d), skipped: null };
  if (json) { process.stdout.write(`${JSON.stringify({ enabled, file, applied: sub === 'apply', projects: r.trusted, skipped: r.skipped })}\n`); return; }
  if (!enabled) process.stdout.write(`auto-trust is off: ${file} does not say "enabled": true\n`);
  if (r.skipped) process.stdout.write(`${r.skipped}\n`);
  if (!r.trusted.length) process.stdout.write('every local repository project is trusted\n');
  for (const p of r.trusted) process.stdout.write(`${sub === 'apply' ? 'trusted' : 'would trust'}  ${p.name}  (${p.id})\n`);
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
    else if (parsed.verb === 'retire') await retire(parsed.opts);
    else if (parsed.verb === 'wakes') await wakes(parsed.opts);
    else if (parsed.verb === 'stuck') await stuck(parsed.opts);
    else if (parsed.verb === 'trust') await trust(parsed.opts);
    else if (parsed.agent) process.exitCode = await runAgent(parsed.agent);
    else await restore(parsed.opts);
  } catch (e) {
    if (e instanceof ShepherdError) process.stderr.write(`shepherd: ${e.code}: ${e.message}\n`);
    else process.stderr.write(`shepherd: error: ${e.message}. Fix: run shepherd status again, and file an issue if it repeats.\n`);
    process.exitCode = 1;
  }
}
