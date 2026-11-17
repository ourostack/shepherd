// The `shepherd` command table, declared with Ouro AX's kit: the words and flags each command takes, its help, its --json
// and its exit codes. Each command's `run` returns the data (what --json prints, as one line); `text` is what a person
// reads. Exit codes: 0 ok, 1 the app's data could not be read, a history could not be restored, the agent could not load,
// the app refused a sidebar change, or an agent verb was refused or failed, 2 usage.
// The library (index.mjs) never imports this file: the kit is TypeScript, which Node does not run inside node_modules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineCli, defineCommand } from '../lib/ouro-ui/registry/ouro/ax/command.ts';
import { BASE_EXIT_CODES, defineExitCodes } from '../lib/ouro-ui/registry/ouro/ax/exit-codes.ts';
import { runCli } from '../lib/ouro-ui/registry/ouro/ax/cli.ts';
import { AxError } from '../lib/ouro-ui/registry/ouro/ax/problem.ts';
import { outcome } from '../lib/ouro-ui/registry/ouro/ax/outcome.ts';
import { ShepherdError, deps, planWakes, quotaConfig, quotaRead, quotaStatus, quotaTick, readWakeStates, rows, restoreHistory, runWakeRunners, runnerDeps, sidebarConfig, sidebarFile, sidebarTidy, renderSidebar, snapshot, stateDir, stuckPlan, stuckResumeConfig, stuckResumeFile, trustAll, trustConfig, trustFile, untrusted, wakeStatusLines, wakesConfig, wakesFile } from './index.mjs';
import { renderRetire, retireConfig, retireDeps, retireFile, watchRetire } from './retire.mjs';
import { counts, healthDeps, pass, readWatch, renderWatch } from './health-watch.mjs';
import { install } from './install.mjs';
import { renderQuota, renderReadings } from './quota.mjs';
import { runResident, watchDuties } from './resident.mjs';
import { agentCommands } from './agent-cli.mjs';

const BUG = 'gh issue create -R ourostack/shepherd --title "shepherd <command>: <what happened>" --body "<the command you ran and this error line>"';

// A library error as the kit's: the same line, `shepherd: <code>: <problem>. Fix: <fix>.`; anything else gets a way on and
// the one call that files it.
export function toAxError(e) {
  if (e instanceof AxError) return e;
  if (e instanceof ShepherdError) return new AxError({ code: e.code, exit: 1, thing: e.code, problem: e.problem, fix: e.fix });
  const problem = e instanceof Error ? e.message : String(e);
  return new AxError({ code: 'error', exit: 1, thing: 'error', problem, fix: `run shepherd status again to keep working, and if it repeats file it with the evidence: ${BUG}` });
}

const guard = async (_thing, fn) => {
  try { return await fn(); } catch (e) { throw toAxError(e); }
};

const usage = (thing, problem, fix) => new AxError({ code: 'usage', exit: 2, thing, problem, fix });
const copilotHome = (input) => input['copilot-home'] ?? path.join(os.homedir(), '.copilot');
const lines = (...parts) => parts.flat().filter((l) => l !== null && l !== undefined).join('\n');

// The text of a result that is not just the data: set where the data is made, read by the command's `text`.
const shown = new WeakMap();
const withText = (data, text) => { shown.set(data, text); return data; };
const textOf = (r) => shown.get(r) ?? JSON.stringify(r, null, 2);

const sub = (name, values, fallback) => ({ name: 'action', description: `${values.join(', ')}${fallback ? `; ${fallback} by default` : ''}`, required: false, values });
const takes = (verb, values, got, fix) => {
  if (got !== undefined && !values.includes(got)) throw usage(verb, `it takes ${values.join(' or ')}, not "${got}"`, fix);
};

const command = (def) => defineCommand({ ...def, run: (input, ctx) => guard(def.name, () => def.run(input, ctx)) });
const read = { effect: 'private', readOnly: true };

export const COMMANDS = [
  command({
    name: 'status', summary: 'each local session: short id, title, busy or idle and why, history size', ...read,
    output: '{ sessions: [{ id, title, mode, state, why, history_mb }] }',
    exit: () => 'ok',
    text: (r, input) => (r.sessions.length ? r.sessions.map((s) => `${s.id.slice(0, 8)}  ${s.title || '(untitled)'}  ${s.state} (${s.why})  ${s.history_mb.toFixed(1)} MB`).join('\n') : `no local sessions in ${copilotHome(input)}`),
    async run(input) {
      const d = deps({ copilotHome: copilotHome(input) });
      return { sessions: (await snapshot(d)).map((s) => ({ id: s.id, title: s.title, mode: s.mode, state: s.state, why: s.why, history_mb: Math.round((d.historySize(s.id) / 1048576) * 10) / 10 })) };
    },
  }),
  command({
    name: 'restore-history', summary: 'put back an archived session\'s compressed history', effect: 'private',
    args: [{ name: 'id', description: 'the session id', required: true }],
    output: '{ id, ok, restored, why }',
    exit: (r) => (r.ok ? 'ok' : 'error'),
    text: (r, input) => `${r.restored ? 'restored' : 'nothing to restore for'} ${input.id}${r.why ? `: ${r.why}` : ''}`,
    async run(input, ctx) {
      const r = await restoreHistory(deps({ copilotHome: copilotHome(input) }), input.id);
      if (!r.ok && !ctx.json) throw new AxError({ code: 'restore-failed', exit: 1, thing: 'restore-history', problem: r.why, fix: 'check the session id against shepherd status, then run shepherd restore-history <id> again' });
      return r;
    },
  }),
  command({
    name: 'watch', summary: 'the health watch over the resumed sessions: one pass, or --every to stay resident; --status shows it', effect: 'private',
    flags: {
      quiet: { type: 'boolean', description: 'print nothing unless something needs saying' },
      status: { type: 'boolean', description: 'what the health watch is following: healthy, waiting, asked again, broken' },
      every: { type: 'number', min: 1, placeholder: '<seconds>', description: 'stay resident: each pass runs the health watch, then the quota balancer, the sidebar tidy, and the retire, wake, stuck-resume and trust duties (each only when its config enables it)' },
    },
    output: '--status: { watch, counts }; a pass: { action, counts }',
    exit: () => 'ok',
    text: (r, input) => (r === null ? '' : r.watch !== undefined ? renderWatch(r) : !input.quiet && r.action === 'none' ? 'health watch: nothing to follow yet' : ''),
    async run(input) {
      const home = copilotHome(input);
      if (input.every !== undefined && input.status) throw usage('watch', '--every and --status cannot be used together', 'shepherd watch --status');
      if (input.status) {
        const r = readWatch(stateDir());
        return { ...r, counts: r.watch ? counts(r.watch) : null };
      }
      if (input.every !== undefined) {
        if (!Number.isInteger(input.every)) throw usage('watch', '--every takes whole seconds, 1 or more', 'shepherd watch --every 60');
        const log = (line) => process.stderr.write(`${line}\n`);
        const say = (line) => process.stdout.write(`${line}\n`);
        await runResident({ everyMs: input.every * 1000, duties: watchDuties({ copilotHome: home, quiet: input.quiet === true, say, log }), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log });
        return null;
      }
      const r = await pass({}, healthDeps({ copilotHome: home }), (line) => { if (!input.quiet) process.stdout.write(`${line}\n`); });
      return { action: r.action, counts: r.counts ?? null };
    },
  }),
  command({
    name: 'quota', summary: 'each account\'s premium-request quota; plan: what a tick would do now; status: the last tick', ...read,
    args: [sub('quota', ['read', 'plan', 'status'], 'status')],
    output: 'read: the readings; plan: the tick it would run; status: the last tick, or null',
    exit: () => 'ok',
    text: (r, input) => (input.action === 'read' ? renderReadings(r) : r === null ? 'no quota tick has run yet' : renderQuota(r)),
    async run(input) {
      takes('quota', ['read', 'plan', 'status'], input.action, 'shepherd quota status');
      const id = input.action ?? 'status';
      if (id === 'status') return quotaStatus() ?? null;
      const cfg = quotaConfig();
      const d = deps({ copilotHome: copilotHome(input) });
      return id === 'read' ? quotaRead(d, cfg) : quotaTick(d, { apply: false, cfg });
    },
  }),
  command({
    name: 'sidebar', summary: 'which projects the sidebar shows (a home, or a session); plan changes nothing; apply needs sidebar.json to say "enabled": true', effect: 'private',
    args: [sub('sidebar', ['plan', 'apply'], 'plan')],
    output: '{ …the tidy, enabled }',
    exit: (r) => (r.done.some((d) => !d.ok) ? 'error' : 'ok'),
    text: (r) => textOf(r),
    async run(input) {
      takes('sidebar', ['plan', 'apply'], input.action, 'shepherd sidebar plan');
      const apply = input.action === 'apply';
      const file = sidebarFile();
      const cfg = sidebarConfig(file);
      if (apply && !cfg.enabled) throw new ShepherdError({ code: 'sidebar-off', problem: `the sidebar tidy is off: ${file} does not say "enabled": true`, fix: `set "enabled": true and "homes" in ${file}, then run shepherd sidebar apply` });
      const out = await sidebarTidy(deps({ copilotHome: copilotHome(input) }), { homes: cfg.homes, apply });
      return withText({ ...out, enabled: cfg.enabled }, renderSidebar(out, { enabled: cfg.enabled, file }));
    },
  }),
  command({
    name: 'retire', summary: 'hand-off retirement and the size watch: plan changes nothing; apply archives, flags and asks, only when retire.json enables it', effect: 'private',
    args: [sub('retire', ['plan', 'apply'], 'plan')],
    output: 'the retirement: what it did or would do, and errors',
    exit: (r) => (r.errors.length ? 'error' : 'ok'),
    text: (r) => renderRetire(r),
    async run(input) {
      takes('retire', ['plan', 'apply'], input.action, 'shepherd retire plan');
      const apply = input.action === 'apply';
      const file = retireFile();
      if (apply && !retireConfig(file).enabled) throw usage('retire', `apply is off, because ${file} does not say "enabled": true`, `set "enabled": true in ${file}, or run shepherd retire plan`);
      return watchRetire(retireDeps({ copilotHome: copilotHome(input) }), { apply });
    },
  }),
  command({
    name: 'wakes', summary: 'each wake runner\'s last run, wakes delivered, open wakes and status lines (status); poll runs each now and sends only when wakes.json says "enabled": true', effect: 'private',
    args: [sub('wakes', ['status', 'poll'], 'status')],
    output: '{ enabled, file, runners: [{ name, state }] }; poll while off: { enabled, file, plans }',
    exit: () => 'ok',
    text: (r) => textOf(r),
    async run(input) {
      takes('wakes', ['status', 'poll'], input.action, 'shepherd wakes status');
      const id = input.action ?? 'status';
      const file = wakesFile();
      const cfg = wakesConfig(file);
      const d = deps({ copilotHome: copilotHome(input) });
      const now = d.now();
      if (id === 'poll' && !cfg.enabled) {
        const plans = await planWakes(cfg.runners);
        return withText({ enabled: false, file, plans }, lines(`wakes are off (${file} does not say "enabled": true): nothing was sent`, plans.map((p) => (p.error ? `wake runner ${p.name}: ${p.error}` : lines(`wake runner ${p.name}: would send ${p.wakes.length} wake(s)`, p.wakes.map((w) => `  ${w.session ?? 'no session'}: ${w.message.slice(0, 80)}`))))));
      }
      const states = id === 'poll' ? await runWakeRunners(d.state, cfg.runners, runnerDeps(d, now)) : readWakeStates(d.state);
      return withText({ enabled: cfg.enabled, file, runners: cfg.runners.map((r) => ({ name: r.name, state: states[r.name] ?? null })) }, lines(!cfg.enabled ? `wakes are off: ${file} does not say "enabled": true` : null, !cfg.runners.length ? `no wake runners in ${file}` : null, wakeStatusLines(cfg.runners, states, now)));
    },
  }),
  command({
    name: 'stuck', summary: 'sessions whose loop stopped, and what a stuck resume would do; the watch resumes them only when stuck-resume.json says "enabled": true', ...read,
    args: [sub('stuck', ['plan'], 'plan')],
    output: '{ enabled, file, sessions }',
    exit: () => 'ok',
    text: (r) => textOf(r),
    async run(input) {
      takes('stuck', ['plan'], input.action, 'shepherd stuck plan');
      const file = stuckResumeFile();
      const enabled = stuckResumeConfig(file).enabled;
      const d = deps({ copilotHome: copilotHome(input) });
      const sessions = stuckPlan(await rows(d), d);
      return withText({ enabled, file, sessions }, lines(!enabled ? `stuck resume is off: ${file} does not say "enabled": true` : null, !sessions.length ? 'no stuck sessions' : null, sessions.map((s) => `${s.resume ? 'would resume' : 'would leave'}  ${s.id.slice(0, 8)}  ${s.name}  (${s.why})`)));
    },
  }),
  command({
    name: 'trust', summary: 'the local repository projects the app has not trusted (plan changes nothing); apply trusts them; the watch does it when trust.json says "enabled": true', effect: 'private',
    args: [sub('trust', ['plan', 'apply'], 'plan')],
    output: '{ enabled, file, applied, projects, skipped }',
    exit: () => 'ok',
    text: (r) => textOf(r),
    async run(input) {
      takes('trust', ['plan', 'apply'], input.action, 'shepherd trust plan');
      const apply = input.action === 'apply';
      const file = trustFile();
      const enabled = trustConfig(file).enabled;
      const d = deps({ copilotHome: copilotHome(input) });
      const r = apply ? await trustAll(d) : { trusted: await untrusted(d), skipped: null };
      return withText({ enabled, file, applied: apply, projects: r.trusted, skipped: r.skipped }, lines(!enabled ? `auto-trust is off: ${file} does not say "enabled": true` : null, r.skipped, !r.trusted.length ? 'every local repository project is trusted' : null, r.trusted.map((p) => `${apply ? 'trusted' : 'would trust'}  ${p.name}  (${p.id})`)));
    },
  }),
  command({
    name: 'install', summary: 'load the launch agent that runs "watch --every 60 --quiet" (--dry-run prints it)', effect: 'private',
    flags: { 'dry-run': { type: 'boolean', description: 'print the launch agent and write nothing' } },
    output: '{ ok, label, plist, log }',
    exit: (r) => (r.ok === false ? 'error' : 'ok'),
    text: (r) => `installed ${r.label}: ${r.plist}; logs in ${r.log}`,
    plan: async () => outcome({ action: 'install', state: 'planned', effect: 'private', summary: (await install({ dry: true })).text }),
    async run(_input, ctx) {
      if (ctx.json) throw usage('install', 'it loads a launch agent and has no --json', 'shepherd install, or shepherd install --dry-run to see it');
      const r = await install({ dry: false });
      if (!r.ok) throw new AxError({ code: 'launchctl', exit: 1, thing: 'install', problem: `launchctl could not load ${r.label}: ${r.error || 'no reason given'}`, fix: `check ${r.plist}, then run shepherd install again while logged in to this Mac` });
      return r;
    },
  }),
  command({
    name: 'version', summary: 'the installed version (also --version)', ...read,
    output: '{ version }',
    exit: () => 'ok',
    text: (r) => r.version,
    run: () => ({ version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version }),
  }),
  ...agentCommands({ guard, copilotHome }),
];

export const cli = defineCli({
  name: 'shepherd',
  about: ['keeps the flock: the GitHub Copilot app\'s sessions, as work.', 'The agent verbs (sessions … open) take flags, or one JSON object on stdin with --input -.'],
  exits: defineExitCodes(BASE_EXIT_CODES.map((e) => (e.name === 'error' ? { ...e, meaning: 'error: the app\'s data is unreadable, a history did not restore, the agent did not load, the app refused a sidebar change, or an agent verb was refused; the message says what to do' } : e))),
  globalFlags: { 'copilot-home': { type: 'string', placeholder: '<dir>', description: 'the Copilot app\'s data folder (default ~/.copilot)' } },
  commands: COMMANDS,
});

// --json is one line of JSON, as the callers that read the last line of stdout expect; a bare newline is an empty result.
export function oneLine(stdout, json) {
  return {
    isTTY: stdout.isTTY,
    write(s) {
      if (s === '\n') return true;
      if (json) {
        try { return stdout.write(`${JSON.stringify(JSON.parse(s))}\n`); } catch { /* not JSON: as it is */ }
      }
      return stdout.write(s);
    },
  };
}

export function main(argv, io = process) {
  return runCli(cli, argv, { stdout: oneLine(io.stdout, argv.includes('--json')), stderr: io.stderr, stdin: io.stdin });
}
