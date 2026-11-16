// `shepherd watch --every <s>`: the resident mode the launch agent runs. Each pass runs every duty in turn (the health
// watch, then the quota balancer's tick, with apply, then the sidebar tidy). Passes never overlap, and a duty that throws is
// logged while the next one still runs.
import { deps } from './sessions.mjs';
import { healthDeps, pass } from './health-watch.mjs';
import { config as quotaConfig, listen as listenQuota, tick as quotaTick } from './quota.mjs';
import { sidebarConfig, tidy as sidebarTidy } from './sidebar.mjs';

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

// The duties of one pass, in order. The balancer's listener starts on the first pass that finds the balancer enabled.
// The sidebar tidy runs at most every everyMinutes (sidebar.json), and only when that config is enabled.
export function watchDuties({ copilotHome, quiet = false, say = () => {}, log = () => {} }) {
  const health = healthDeps({ copilotHome });
  let listener = null;
  let lastTidy = -Infinity;
  return [
    { name: 'health watch', run: () => pass({}, health, (line) => { if (!quiet) say(line); }) },
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
  ];
}
