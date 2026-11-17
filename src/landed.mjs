// Is a session's work on main? Retirement archives a session only when nothing in its working folder is lost by it. For a
// workspace session this inspects its folder: uncommitted changes, commits not pushed, and a branch with no merged pull request.
//
//   clean   nothing to land: no changes, nothing unpushed, and the branch is merged (or has nothing beyond the default branch)
//   land    finished work that is not on main: commit what is uncommitted, push the branch, open a pull request with auto-merge
//   hold    anything ambiguous, or work already in flight (an open pull request): not archived, and the reason is given
//
// `check` only reads. `land` writes: it commits, pushes and opens the pull request, then holds the archive until it merges.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const run = (file, argv, cwd) => new Promise((res) => {
  execFile(file, argv, { cwd, timeout: 120000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

export const landDeps = () => ({
  git: (cwd, args) => run('git', args, cwd),
  gh: (cwd, args) => run('gh', args, cwd),
  exists: (p) => fs.existsSync(p),
});

const folderOf = (row) => (row.path ? row.path.replace(/^~(?=\/|$)/, os.homedir()) : null);
const out = (r) => r.stdout.trim();
const hold = (why) => ({ outcome: 'hold', why });

export async function checkLanded(row, d) {
  const ld = d.landDeps ?? landDeps();
  if (row.kind === 'chat') return { outcome: 'clean', why: 'a chat has no working folder' };
  const cwd = folderOf(row);
  if (!cwd) return hold('no working folder is recorded for it, so its work cannot be checked');
  if (!ld.exists(cwd)) return hold(`its working folder ${cwd} is gone, so its work cannot be checked`);
  const inside = await ld.git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return hold(`${cwd} is not a git working folder`);
  if ((await ld.git(cwd, ['fetch', '-q', 'origin'])).code !== 0) return hold('git could not fetch origin, so what is on main cannot be confirmed');
  const head = await ld.git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = out(head);
  if (!branch) return hold('its working folder is on a detached HEAD');
  const sha = out(await ld.git(cwd, ['rev-parse', 'HEAD']));
  const dirty = out(await ld.git(cwd, ['status', '--porcelain'])).length > 0;
  const def = out(await ld.git(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])).replace(/^origin\//, '') || 'main';
  const count = async (range) => {
    const r = await ld.git(cwd, ['rev-list', '--count', range]);
    return r.code === 0 ? Number(out(r)) : null;
  };
  const ahead = await count(`origin/${def}..HEAD`);
  if (ahead === null) return hold(`origin/${def} is not known in its working folder`);
  const hasRemote = (await ld.git(cwd, ['rev-parse', '--verify', '-q', `origin/${branch}`])).code === 0;
  const unpushed = hasRemote ? await count(`origin/${branch}..HEAD`) : ahead;
  if (unpushed === null) return hold('git could not count its unpushed commits');
  const base = { cwd, branch, sha, def, dirty, unpushed, ahead };
  if (branch === def) {
    if (dirty || ahead > 0) return { ...base, ...hold(`it has ${dirty ? 'uncommitted changes' : ''}${dirty && ahead > 0 ? ' and ' : ''}${ahead > 0 ? `${ahead} unpushed commit(s)` : ''} on ${def} itself, which cannot be landed by a pull request`) };
    return { ...base, outcome: 'clean', why: `clean on ${def}` };
  }
  const listed = await ld.gh(cwd, ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url,headRefOid']);
  let prs;
  try { prs = JSON.parse(out(listed) || '[]'); } catch { prs = null; }
  if (listed.code !== 0 || !Array.isArray(prs)) return { ...base, ...hold('GitHub did not say whether the branch has a merged pull request') };
  const open = prs.find((p) => p.state === 'OPEN');
  if (!dirty && unpushed === 0) {
    if (ahead === 0) return { ...base, outcome: 'clean', why: `${branch} has nothing beyond ${def}` };
    if (prs.some((p) => p.state === 'MERGED' && p.headRefOid === sha)) return { ...base, outcome: 'clean', why: `${branch} is merged` };
    if (open) return { ...base, ...hold(`pull request #${open.number} is open and has not merged yet (${open.url})`), pr: open.url };
    if (prs.some((p) => p.state === 'CLOSED')) return { ...base, ...hold(`its branch ${branch} has a pull request that was closed without merging`) };
  }
  return { ...base, outcome: 'land', open: open?.url ?? null, why: `${[dirty && 'uncommitted changes', unpushed > 0 && `${unpushed} unpushed commit(s)`, !dirty && unpushed === 0 && 'a pushed branch with no pull request'].filter(Boolean).join(' and ')} on ${branch}` };
}

// Lands what `check` found: commit, push, pull request, auto-merge. Returns { ok, url } or { ok: false, why }.
export async function land(found, d) {
  const ld = d.landDeps ?? landDeps();
  const { cwd, branch } = found;
  const fail = (why) => ({ ok: false, why });
  if (found.dirty) {
    if ((await ld.git(cwd, ['add', '-A'])).code !== 0) return fail('git could not stage its changes');
    if ((await ld.git(cwd, ['commit', '-q', '-m', `Save the work in progress on ${branch}`])).code !== 0) return fail('git could not commit its changes');
  }
  if ((await ld.git(cwd, ['push', '-u', 'origin', 'HEAD'])).code !== 0) return fail(`git could not push ${branch}`);
  let url = found.open;
  if (!url) {
    const title = out(await ld.git(cwd, ['log', '-1', '--format=%s'])) || `Land ${branch}`;
    const made = await ld.gh(cwd, ['pr', 'create', '--head', branch, '--base', found.def, '--title', title, '--body', `Lands the finished work from the branch ${branch}.`]);
    if (made.code !== 0) return fail(`the branch was pushed, but the pull request could not be opened: ${made.stderr.trim().slice(0, 120)}`);
    url = out(made).split('\n').at(-1);
  }
  const auto = await ld.gh(cwd, ['pr', 'merge', url, '--auto', '--squash']);
  if (auto.code !== 0) return { ok: false, url, why: `pull request ${url} is open, but auto-merge could not be turned on: ${auto.stderr.trim().slice(0, 120)}` };
  return { ok: true, url };
}

// The gate in front of every archive: only a session whose work is on main goes. Returns null to go ahead, or the entry that
// says why it stays. In a plan, unlanded work is reported as `land` (what apply would do); in apply it is landed and held.
export async function landedGate(row, d, apply, reason) {
  let found;
  try { found = await (d.checkLanded ? d.checkLanded(row, d) : checkLanded(row, d)); } catch (e) { found = { outcome: 'hold', why: `its work could not be checked (${e.message})` }; }
  if (found.outcome === 'clean') return null;
  const entry = (what, why, over = {}) => ({ what, id: row.id, name: row.name, reason, done: false, why, ...over });
  if (found.outcome === 'hold') return entry('hold', found.why, { reason: 'unlanded', pr: found.pr });
  if (!apply) return entry('land', `${found.why}: would commit, push and open a pull request with auto-merge, and archive once it merges`, { reason: 'unlanded' });
  const r = await (d.land ? d.land(found, d) : land(found, d));
  if (!r.ok) return entry('hold', r.why, { reason: 'unlanded', pr: r.url });
  return entry('hold', `landing ${found.why} through ${r.url}; archived once it merges`, { reason: 'landing', pr: r.url });
}
