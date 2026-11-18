// `shepherd watch --every <s>`: the resident mode the launch agent runs. Each pass runs every duty in turn (the health
// watch, then the quota balancer's tick, with apply, then the sidebar tidy, then the retire duty: hand-off retirement and the
// size watch, then the wake runners, the stuck resume, the repository trust and the GitHub inbox, each once its config enables it). Passes never overlap, and a duty
// that throws is logged while the next one still runs.
import { deps } from './sessions.mjs';
import { healthDeps, pass } from './health-watch.mjs';
import { config as quotaConfig, listen as listenQuota, tick as quotaTick } from './quota.mjs';
import { sidebarConfig, tidy as sidebarTidy } from './sidebar.mjs';
import { actionLine, retireConfig, retireDeps, watchRetire } from './retire.mjs';
import { rows as sessionRows } from './rows.mjs';
import { runDueWakes, wakesConfig } from './wakes.mjs';
import { resumeStuck, stuckResumeConfig } from './stuck-resume.mjs';
import { trustAll, trustConfig } from './trust.mjs';
import { inboxConfig, pollInboxes } from './inbox.mjs';
import { listenPrompts } from './prompts.mjs';
import { sample as sampleResponsiveness } from './responsiveness.mjs';

// Runs the duties every everyMs until stop() is true. The clock and the sleep are injected, so a test can run it on a fake one.
export async function runResident({ everyMs, duties, now = () => Date.now(), sleep, stop = () => false, log = () => {} }) {
  while (!stop()) {
    const started = now();
    for (const duty of duties) {
      try { await duty.run(); } catch (e) { log(`shepherd: ${duty.name} failed: ${e.message}`); }
    }
    if (stop()) return;
    await sleep(Math.max(0, everyMs - (now() - started)));
  }
}

// The duties of one pass, in order. The responsiveness reading goes second, so a slow pass shows in its own numbers. The prompt tracker's connection starts on the first pass. The balancer's listener starts on the first pass that finds the balancer enabled. The
// sidebar tidy runs at most every everyMinutes (sidebar.json), and only when that config is enabled. The retire duty (hand-off
// retirement, then the size watch) does nothing until its config file says "enabled": true. The wake runners and the stuck
// resume are off until wakes.json and stuck-resume.json say so; a runner's own cadence is checked on each pass.
export function watchDuties({ copilotHome, quiet = false, say = () => {}, log = () => {} }) {
  const health = healthDeps({ copilotHome });
  let listener = null;
  let prompts = null;
  let lastTidy = -Infinity;
  const wakeDue = new Map();
  return [
    { name: 'health watch', run: () => pass({}, health, (line) => { if (!quiet) say(line); }) },
    // Holds one observer connection open, so the questions and plans the app announces are heard for answer and plan.
    { name: 'responsiveness', run: () => sampleResponsiveness(deps({ copilotHome })) },
    { name: 'prompt tracker', run: () => { prompts ??= listenPrompts(deps({ copilotHome })); } },
    {
      name: 'quota balancer',
      run: async () => {
        const cfg = quotaConfig();
        if (!cfg.enabled) return;
        const d = deps({ copilotHome });
        listener ??= listenQuota(d, { log });
        const r = await quotaTick(d, { apply: true, cfg });
        const moved = r.done?.moved?.length ?? 0;
        const resumed = r.done?.resumed?.length ?? 0;
        if (!quiet && (moved || resumed)) say(`quota balancer: ${moved} project(s) moved, ${resumed} session(s) messaged`);
      },
    },
    {
      name: 'sidebar tidy',
      run: async () => {
        const cfg = sidebarConfig();
        if (!cfg.enabled) return;
        const now = Date.now();
        if (now - lastTidy < cfg.everyMinutes * 60000) return;
        lastTidy = now;
        const r = await sidebarTidy(deps({ copilotHome }), { homes: cfg.homes, apply: true });
        const changed = r.done.filter((d) => d.ok).length;
        if (!quiet && changed) say(`sidebar tidy: ${changed} project(s) changed`);
        for (const d of r.done.filter((x) => !x.ok)) log(`shepherd: sidebar tidy: ${d.name || d.id} was not changed: ${d.error}`);
      },
    },
    {
      name: 'retire',
      run: async () => {
        if (!retireConfig().enabled) return;
        const r = await watchRetire(retireDeps({ copilotHome }), { apply: true, idleLanded: retireConfig().idleLanded });
        for (const err of r.errors) log(`shepherd: retire: ${err}`);
        for (const s of r.unload?.stop ?? []) if (s.done && !quiet) say(`retire: stopped the idle runtime ${s.pid} (${s.sessions} session(s), ${s.rssMb} MB) under swap pressure; a message to a session loads it again`);
        for (const e of [...r.retire, ...r.size]) if (e.done && e.what !== 'flag' && !quiet) say(`retire: ${actionLine(e)}`);
      },
    },
    {
      name: 'wake runners',
      run: async () => {
        const cfg = wakesConfig();
        if (!cfg.enabled || !cfg.runners.length) return;
        const states = await runDueWakes(deps({ copilotHome }), cfg.runners, wakeDue);
        let delivered = 0;
        for (const [name, state] of Object.entries(states)) {
          delivered += state.lastDelivered ?? 0;
          if (state.lastError) log(`shepherd: wake runner ${name}: ${state.lastError}`);
        }
        if (!quiet && delivered) say(`wake runners: ${delivered} wake(s) delivered`);
      },
    },
    {
      name: 'stuck resume',
      run: async () => {
        if (!stuckResumeConfig().enabled) return;
        const d = deps({ copilotHome });
        const resumed = await resumeStuck(await sessionRows(d), d);
        if (!quiet && resumed) say(`stuck resume: ${resumed} session(s) resumed`);
      },
    },
    {
      name: 'trust',
      run: async () => {
        if (!trustConfig().enabled) return;
        const r = await trustAll(deps({ copilotHome }));
        if (r.skipped) log(`shepherd: trust: ${r.skipped}`);
        for (const p of r.trusted) log(`shepherd: trust: trusted ${p.name} (${p.id})`);
      },
    },
    {
      name: 'inbox',
      run: async () => {
        const cfg = inboxConfig();
        if (!cfg.enabled) return;
        const results = await pollInboxes(deps({ copilotHome }), cfg, { apply: true });
        for (const r of results) {
          if (r.error) log(`shepherd: inbox ${r.account}: ${r.error}`);
          for (const x of r.done ?? []) log(`shepherd: inbox ${r.account}: done ${x.repo} "${x.title}" [${x.reason}] ${x.why}`);
        }
        const n = results.reduce((sum, r) => sum + (r.done?.length ?? 0), 0);
        if (!quiet && n) say(`inbox: ${n} agent-caused notification(s) marked done`);
      },
    },
  ];
}
