// A session an agent started that sits on a plan approval nobody answers is a lane waiting unseen. The app announces each plan
// once, to the observers connected then, and the prompt tracker records it with the time. When such a plan is still open after
// PLAN_WAIT_MS and its session was created by another session (an agent), this approves it to continue in autopilot. A session
// the owner opened (no creator session) is left for the owner.
import { readPending } from './store.mjs';
import { rows } from './rows.mjs';
import { plan } from './operate.mjs';

export const PLAN_WAIT_MS = 2 * 60000;

// Returns the ids of the sessions whose plan it approved.
export async function approveStalePlans(d, { waitMs = PLAN_WAIT_MS, now = () => d.now() } = {}) {
  const pending = readPending(d);
  const stale = Object.entries(pending).filter(([, request]) => request.kind === 'plan' && now() - Date.parse(request.at) >= waitMs);
  if (!stale.length) return [];
  const listed = await rows(d);
  const approved = [];
  for (const [id] of stale) {
    const row = listed.find((r) => r.id === id);
    if (!row || row.awaiting !== 'plan' || !row.creatorSessionId) continue;
    const r = await plan(d, { session_id: id, approved: true, selected_action: 'autopilot' });
    if (r.ok) approved.push(id);
  }
  return approved;
}
