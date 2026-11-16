// The sidebar tidy: the app's sidebar shows a project when it is a home (a path listed in sidebar.json) or holds at least
// one unarchived session, local or cloud. Any other project is hidden. Showing and hiding use the app's own request on its
// socket, and nothing else is written. `shepherd watch --every` runs it at most every everyMinutes, and only when enabled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShepherdError } from './error.mjs';

export const SIDEBAR_DEFAULTS = { enabled: false, homes: [], everyMinutes: 30 };

export const sidebarFile = (env = process.env, home = os.homedir()) => env.SHEPHERD_SIDEBAR_CONFIG || path.join(home, '.config', 'shepherd', 'sidebar.json');

// sidebar.json: enabled, homes (absolute paths) and everyMinutes. No file, or enabled not true: the duty does nothing.
export function sidebarConfig(file = sidebarFile()) {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new ShepherdError({ code: 'sidebar-config', problem: `${file} is not valid JSON (${e.message})`, fix: 'fix the file, or delete it to turn the sidebar tidy off' });
  }
  const homes = user.homes ?? SIDEBAR_DEFAULTS.homes;
  const every = user.everyMinutes ?? SIDEBAR_DEFAULTS.everyMinutes;
  if (!Array.isArray(homes) || !homes.every((h) => typeof h === 'string')) throw new ShepherdError({ code: 'sidebar-config', problem: `"homes" in ${file} is not a list of paths`, fix: 'write "homes" as a JSON list of absolute folder paths' });
  if (!Number.isInteger(every) || every < 1) throw new ShepherdError({ code: 'sidebar-config', problem: `"everyMinutes" in ${file} is not a whole number of minutes, 1 or more`, fix: 'write "everyMinutes" as 30, say' });
  return { enabled: user.enabled === true, homes, everyMinutes: every };
}

export const PROJECTS = 'SELECT id, name, main_repo_path, show_in_sidebar FROM projects';
// A session's project is its workspace's, else its side chat's workspace's, else its account pin's (as quota.mjs reads it).
export const SIDEBAR_SESSIONS = `SELECT s.id, COALESCE(w.project_id, (SELECT w2.project_id FROM workspace_side_chats sc JOIN workspaces w2 ON w2.id = sc.workspace_id WHERE sc.session_id = s.id), (SELECT project_id FROM session_account_projects WHERE session_id = s.id)) AS project_id
FROM sessions s LEFT JOIN workspaces w ON w.session_id = s.id
WHERE s.archived_at IS NULL AND (w.archived_at IS NULL)`;

const bare = (p) => String(p).replace(/\/+$/, '');
const isShown = (v) => v === true || v === 1 || v === '1';

// Pure. One entry per project: whether it should show, why, and whether that changes what the app has now.
export function sidebarPlan(projects, sessions, { homes = [] } = {}) {
  const home = new Set(homes.map(bare));
  const seen = new Set();
  const count = new Map();
  for (const s of sessions) {
    if (!s.project_id || seen.has(s.id)) continue;
    seen.add(s.id);
    count.set(s.project_id, (count.get(s.project_id) || 0) + 1);
  }
  return projects.map((p) => {
    const isHome = Boolean(p.main_repo_path) && home.has(bare(p.main_repo_path));
    const n = count.get(p.id) || 0;
    const show = isHome || n > 0;
    const was = isShown(p.show_in_sidebar);
    return { id: p.id, name: p.name, home: isHome, sessions: n, show, why: isHome ? 'a home' : n > 0 ? `${n} unarchived session(s)` : 'no sessions', was, changes: show !== was };
  });
}

// Asks the app to show or hide one project. Each request has its own socket, so any error on it is its own.
async function setShown(deps, projectId, show, waitMs) {
  const got = await deps.exchange([{ type: 'set_project_sidebar_visibility', project_id: projectId, show_in_sidebar: show }], {
    keep: (j) => (j.type === 'project_updated' && j.project?.id === projectId) || j.type === 'error' || j.type === 'socket_error',
    done: () => true,
    waitMs,
  });
  const hit = got.find((j) => j.type === 'project_updated');
  const refused = got.find((j) => j.type === 'error' || j.type === 'socket_error');
  return { ok: Boolean(hit), error: hit ? null : refused ? String(refused.message || refused.type).slice(0, 200) : 'the app did not answer. Fix: open the GitHub Copilot app and try again.' };
}

// Plans the sidebar from the app's database and, with apply, sends only the changes. Reads the database only.
export async function tidy(deps, { homes = [], apply = false, waitMs = 8000 } = {}) {
  const projects = await deps.sql(PROJECTS);
  const sessions = await deps.sql(SIDEBAR_SESSIONS);
  const plan = sidebarPlan(projects, sessions, { homes });
  const done = [];
  if (apply) {
    for (const p of plan.filter((x) => x.changes)) done.push({ id: p.id, name: p.name, show: p.show, ...(await setShown(deps, p.id, p.show, waitMs)) });
  }
  return { ok: done.every((d) => d.ok), applied: apply, plan, done };
}

export function renderSidebar(out, { enabled = true, file = sidebarFile() } = {}) {
  const lines = [];
  if (!enabled) lines.push(`(the sidebar tidy is off: set "enabled": true in ${file} to let it change the sidebar)`);
  const shown = out.plan.filter((p) => p.show).length;
  lines.push(`sidebar: ${shown} shown, ${out.plan.length - shown} hidden, ${out.plan.filter((p) => p.changes).length} to change`);
  for (const p of out.plan) {
    const change = out.done.find((d) => d.id === p.id);
    const state = `${p.show ? 'show' : 'hide'}  ${p.name || p.id}  (${p.why})`;
    lines.push(`  ${state}${change ? (change.ok ? '  changed' : `  refused: ${change.error}`) : p.changes ? '  not applied' : ''}`);
  }
  return lines.join('\n');
}
