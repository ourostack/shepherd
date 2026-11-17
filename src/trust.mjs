// Repository trust: the GitHub Copilot app holds every session in a repository project at "Ask every time" until someone presses
// the trust button on that project. The button writes three rows in the app's own database; this duty writes the same three for
// every local repository project that lacks them, so no session waits on the button. It copies the config hash of a project that
// is already trusted (the "trust future changes" row makes the hash moot) and does nothing while no project is trusted yet.
// Nothing runs until ~/.config/shepherd/trust.json (or SHEPHERD_TRUST_CONFIG) says "enabled": true. Remote projects are left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShepherdError } from './error.mjs';

export const trustFile = (env = process.env, home = os.homedir()) => env.SHEPHERD_TRUST_CONFIG || path.join(home, '.config', 'shepherd', 'trust.json');

// The trust config: { enabled } from trust.json. No file: off. A file that is not JSON is an error.
export function trustConfig(file = trustFile()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { enabled: false };
    throw new ShepherdError({ code: 'trust-config', problem: `${file} could not be read (${e.message})`, fix: 'check the file, or delete it to turn auto-trust off' });
  }
  try {
    return { enabled: JSON.parse(text)?.enabled === true };
  } catch (e) {
    throw new ShepherdError({ code: 'trust-config', problem: `${file} is not valid JSON (${e.message})`, fix: 'fix the file, or delete it to turn auto-trust off' });
  }
}

const LOCAL_REPOS = "container_kind = 'repository' AND main_repo_path NOT LIKE 'remote://%'";
const UNTRUSTED = `SELECT p.id, p.name FROM projects p WHERE ${LOCAL_REPOS}
  AND (NOT EXISTS (SELECT 1 FROM project_host_trust t WHERE t.project_id = p.id AND t.host_id = 'local')
    OR NOT EXISTS (SELECT 1 FROM project_future_config_trust f WHERE f.project_id = p.id)
    OR NOT EXISTS (SELECT 1 FROM project_trust_revisions r WHERE r.project_id = p.id))
ORDER BY p.name`;
const HASH = "SELECT trusted_config_sha256 AS hash FROM project_host_trust WHERE host_id = 'local' ORDER BY trusted_config_accepted_at DESC LIMIT 1";
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;

// The local repository projects without the app's trust rows: [{ id, name }]. Changes nothing.
export const untrusted = (d) => d.sql(UNTRUSTED);

// Trusts every local repository project that is not yet trusted, in one transaction. Idempotent: a project that already has a row keeps it.
// Resolves to { trusted: [{ id, name }], skipped: reason | null }.
export async function trustAll(d, now = d.now()) {
  const todo = await untrusted(d);
  if (!todo.length) return { trusted: [], skipped: null };
  const [{ hash } = {}] = await d.sql(HASH);
  if (!hash) return { trusted: [], skipped: 'no project is trusted yet, so there is no config hash to copy' };
  const at = quote(new Date(now).toISOString());
  const ids = todo.map((p) => quote(p.id)).join(', ');
  await d.sqlWrite(`INSERT OR IGNORE INTO project_host_trust (project_id, host_id, trusted_config_sha256, trusted_config_accepted_at) SELECT id, 'local', ${quote(hash)}, ${at} FROM projects WHERE id IN (${ids});
INSERT OR IGNORE INTO project_future_config_trust (project_id, accepted_at) SELECT id, ${at} FROM projects WHERE id IN (${ids});
INSERT OR IGNORE INTO project_trust_revisions (project_id, revision, local_revision) SELECT id, 1, 0 FROM projects WHERE id IN (${ids});`);
  return { trusted: todo, skipped: null };
}
