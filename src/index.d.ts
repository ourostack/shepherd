export class ShepherdError extends Error {
  code: string;
  problem: string;
  fix: string;
  constructor(detail: { code: string; problem: string; fix: string });
}

export const READY: 'READY-TO-RESTART';
export const DEFER: 'DEFER';
export const TAIL_BYTES: number;
export const MAX_HISTORY_BYTES: number;
export const STALE_MS: number;
export const LOOKBACK_MS: number;
export const ARCHIVE_WAIT_MS: number;
export const ROWS: string;

export interface ResumeTiming {
  /** The wait the caller takes after the app is back, before its snapshot. */
  grace: number;
  delivery: number;
  retry: number;
  tries: number;
  concurrency: number;
  backoff: number[];
}
export const RESUME_T: ResumeTiming;

export interface ResumeTarget {
  id: string;
  why: string;
  known: boolean;
  title: string | null;
  /** The history's bytes when it is over the resume cap; the target is held, not sent. */
  oversize: number | null;
  sizeWhy: string | null;
}

export interface ResumeResult {
  id: string;
  title: string | null;
  why: string;
  outcome: string;
  tries?: number;
  last?: string;
}

export interface ResumeRecord {
  at: string;
  why: string | null;
  since: string;
  /** Ids that resumed, or were already continued by another resumer. */
  resumed: string[];
  results: ResumeResult[];
}

export interface SessionRow {
  id: string;
  title: string | null;
  mode: string | null;
  running: 0 | 1 | boolean;
  interrupted: 0 | 1 | boolean;
  loc: string | null;
  workspace_id: string | null;
}

export interface History {
  lines: string[];
  mtime: number;
}

export interface LoopState {
  working: boolean;
  why: string;
}

export interface Snapshot {
  id: string;
  title: string | null;
  mode: string | null;
  state: 'busy' | 'idle';
  why: string;
  running: boolean;
  interrupted: boolean;
  workspaceId: string | null;
  oversize?: number;
  stale?: boolean;
}

export interface Reply {
  kind: 'ready' | 'defer';
  at: number;
  lanes?: number;
  minutes?: number | null;
}

export interface Deps {
  /** The GitHub Copilot app's home folder (data.db, session-state, run/, logs/). */
  copilotHome: string;
  /** Shepherd's own records (the last resume, the health watch): ~/Library/Caches/shepherd by default. */
  state: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  sql(query: string): Promise<SessionRow[]>;
  history(id: string): History;
  historySize(id: string): number;
  exchange(messages: object[], opts?: { done?: (j: any, got: any[]) => boolean; keep?: (j: any) => boolean; waitMs?: number }): Promise<any[]>;
  historyPath(id: string): string;
  /** Compresses the file to file + '.gz' and removes the original. */
  gzip(file: string): Promise<void>;
  /** Decompresses a .gz file back beside itself and removes the .gz. */
  gunzip(gz: string): Promise<void>;
  /** The pids that have the file open; rejects when lsof cannot say. */
  openBy(file: string): Promise<string[]>;
  ledger(row: LedgerRow): Promise<void> | void;
}

export interface LedgerRow {
  at: string;
  kind: 'history-compressed';
  by: 'shepherd';
  session: string;
  before: number;
  after: number;
}

export interface CompressResult {
  id: string;
  ok: boolean;
  before: number | null;
  after: number | null;
  why: string | null;
}

export interface RestoreResult {
  id: string;
  ok: boolean;
  restored: boolean;
  why: string | null;
}

export interface ArchiveRow {
  id: string;
  workspaceId?: string | null;
  /** Only "worktree" deletes the worktree; left unset, archive keeps it. */
  workspaceType?: string | null;
}

export function readTail(file: string, bytes?: number, opts?: { keepPartial?: boolean }): string[];
export function lastTurnAt(lines: string[]): number | null;
export function loopState(lines: string[]): LoopState;
export function continuedSince(lines: string[], since: number): boolean;
export function tookTurnSince(lines: string[], since: number): boolean;
export function lastReply(lines: string[], since: number): Reply | null;

export function deps(options?: { copilotHome?: string; ledger?: string; state?: string }): Deps;
export function stateDir(home?: string): string;
export function historyFile(copilotHome: string, id: string): string;
export function snapshot(deps: Deps, now?: number, skip?: string[]): Promise<Snapshot[]>;

export function exchange(copilotHome: string, messages: object[], opts?: { done?: (j: any, got: any[]) => boolean; keep?: (j: any) => boolean; waitMs?: number }): Promise<any[]>;
export function appReady(deps: Deps): Promise<boolean>;
export function sendTo(deps: Deps, id: string, prompt: string, waitMs?: number, delivery?: 'immediate' | 'enqueue'): Promise<{ ok: boolean; reply: string; error: string | null }>;
/** Once the app confirms, compresses the session's history (unless compress is false); compressed is null otherwise. */
export function archive(deps: Deps, row: ArchiveRow, opts?: { keepWorktree?: boolean; waitMs?: number; compress?: boolean }): Promise<{ ok: boolean; session_id: string; error: string | null; compressed: CompressResult | null }>;
export function compressHistory(deps: Deps, id: string, opts?: { dryRun?: boolean }): Promise<CompressResult>;
export function restoreHistory(deps: Deps, id: string): Promise<RestoreResult>;

/** The balancer's settings, from quota.json (off unless "enabled": true; every other key defaults as shown in src/quota.mjs). */
export interface QuotaConfig {
  enabled: boolean;
  low_pct: number;
  out_pct: number;
  tranches: number[];
  max_moves: number;
  stall_window_h: number;
  stale_h: number;
  listen_ms: number;
  resume_retry_ms: number;
  warn_h: number;
  burn_window_h: number;
  prefer_unlimited: boolean;
  respect_user_pins: boolean;
  resume_window_min: number;
  exclude: string[];
  repo_rules: { repo: string | string[]; accounts: string | string[] }[];
  account_rules: { account: string | string[]; repos: string | string[] }[];
  share: { gist_id: string; gh_user: string | null } | null;
  me: string;
}

export interface QuotaReading {
  unlimited: boolean;
  entitlement: number | null;
  remaining: number | null;
  /** Percent of included requests left. */
  pct: number | null;
  has_quota: boolean | null;
  overage_permitted: boolean | null;
  reset: string | null;
  spent: number | null;
  source: string;
  at: string;
}

/** The balancer's config, read from quota.json (SHEPHERD_QUOTA_CONFIG overrides the path). Throws when the file is not JSON. */
export function quotaConfig(file?: string): QuotaConfig;
/** Every signed-in account's reading, from every source (apply is never set here). */
export function quotaRead(deps: Deps, cfg?: QuotaConfig): Promise<{ readings: Record<string, QuotaReading>; errors: Record<string, string> }>;
/** One tick. apply false plans and changes nothing; apply true moves projects and messages sessions, and does nothing when the config is off. */
export function quotaTick(deps: Deps, opts?: { apply?: boolean; only?: string | null; cfg?: QuotaConfig; now?: number }): Promise<Record<string, any>>;
/** The last applied tick's result, or null. */
export function quotaStatus(): Record<string, any> | null;
/** Keeps the app's per-account quota broadcasts in a file; reconnects while the app is down. */
export function listenQuota(deps: Deps, opts?: { log?: (line: string) => void; file?: string; retryMs?: number }): { stop(): void };

export function pickTargets(o: { before: Snapshot[]; after: Snapshot[]; also?: string[] }): ResumeTarget[];
export function resumeText(o: { at: number; why?: string | null; lanes?: { lanes?: number; minutes?: number | null } | null }): string;
/** Sends one resume message to each target and waits for a turn. Writes <state>/resume-last.json when anything resumed. */
export function resume(
  deps: Deps & { heldBack?: (held: { id: string; title: string | null; bytes: number }[]) => void },
  o: { targets: ResumeTarget[]; startedAt: number; restartedAt: number; why?: string | null; lanes?: Map<string, { lanes?: number; minutes?: number | null }>; t?: Partial<ResumeTiming>; log?: (line: string) => void },
): Promise<ResumeResult[]>;

/** The sidebar tidy's settings, from sidebar.json (off unless "enabled": true). */
export interface SidebarConfig {
  enabled: boolean;
  /** Absolute paths of the projects' main checkouts that always show. */
  homes: string[];
  everyMinutes: number;
}

export interface SidebarEntry {
  id: string;
  name: string | null;
  home: boolean;
  sessions: number;
  show: boolean;
  why: string;
  was: boolean;
  changes: boolean;
}

/** The sidebar tidy's config, read from sidebar.json (SHEPHERD_SIDEBAR_CONFIG overrides the path). Throws when the file is not valid. */
export function sidebarConfig(file?: string): SidebarConfig;
export function sidebarFile(env?: Record<string, string | undefined>, home?: string): string;
/** Pure: whether each project should show, and why. A project shows when it is a home or holds an unarchived session, local or cloud. */
export function sidebarPlan(projects: { id: string; name?: string | null; main_repo_path?: string | null; show_in_sidebar?: unknown }[], sessions: { id: string; project_id?: string | null }[], opts?: { homes?: string[] }): SidebarEntry[];
/** Plans the sidebar from the app's database; apply sends the app a show or hide request for each change only. Never writes the database. */
export function sidebarTidy(deps: Deps, opts?: { homes?: string[]; apply?: boolean; waitMs?: number }): Promise<{ ok: boolean; applied: boolean; plan: SidebarEntry[]; done: { id: string; name: string | null; show: boolean; ok: boolean; error: string | null }[] }>;
export function renderSidebar(out: { plan: SidebarEntry[]; done: { id: string; name: string | null; ok: boolean; error: string | null }[] }, opts?: { enabled?: boolean; file?: string }): string;
/** One app session as the sidebar lists it, with what its own history says it is doing (src/rows.mjs). */
export interface AppSessionRow {
  id: string;
  name: string;
  kind: 'workspace' | 'chat';
  workspaceId: string | null;
  workspaceType: string | null;
  projectRepo: string | null;
  branch: string | null;
  parentSessionId: string | null;
  coordinatingCreatorSessionId: string | null;
  state: 'working' | 'waiting' | 'stuck' | 'idle';
  detail: string;
  isRunning: boolean;
  remote: boolean;
  updatedAt: string | null;
  lastActivity: string | null;
  awaiting?: 'input' | 'plan' | 'permission';
  openPullRequest?: string;
  automation?: true;
}

/** One decision of the retire duties or the size watch. done is false in a plan. */
export interface RetireAction {
  what: 'archive' | 'hold' | 'flag' | 'ask' | 'owner';
  id: string;
  name?: string;
  reason?: 'handed-off' | 'finished' | 'oversize-idle' | 'memory-pressure';
  done: boolean;
  why: string;
  to?: string[];
}

export interface RetireResult {
  retire: RetireAction[];
  size: RetireAction[];
  errors: string[];
}

/** The app's sidebar sessions with their state (throws ShepherdError when the app is not serving). */
export function rows(deps: Deps, now?: number): Promise<AppSessionRow[]>;
/** The retire config from retire.json (SHEPHERD_RETIRE_CONFIG overrides the path). No file: { enabled: false }. */
export function retireConfig(file?: string): { enabled: boolean };
export function retireFile(env?: Record<string, string | undefined>, home?: string): string;
export function retireDeps(opts?: { copilotHome?: string; base?: Deps }): Deps & { tell(text: string): Promise<{ ok: boolean; error: string | null }> };
/** Hand-off and orphan retirement over the sidebar's sessions. apply false decides and changes nothing. */
export function retireSessions(listed: AppSessionRow[], deps: Deps, opts?: { apply?: boolean }): Promise<RetireAction[]>;
/** One pass of retirement then the size watch. apply false is a plan. */
export function watchRetire(deps: Deps, opts?: { apply?: boolean }): Promise<RetireResult>;
/** Flags over-limit histories, asks for hand-offs, and archives idle giants. */
export function noticeOversizedSessions(listed: AppSessionRow[], deps: Deps, opts?: { apply?: boolean }): Promise<{ nudged: number; archived: number; actions: RetireAction[] }>;
export function whereItLeftOff(row: { id: string; branch?: string | null; projectRepo?: string | null }, deps: Deps): string;

/** One wake runner from wakes.json: its command runs every everySeconds, and its wakes go to session (or to the one it names). */
export interface WakeRunner {
  name: string;
  command: string[];
  everySeconds: number;
  delivery: 'immediate' | 'enqueue';
  session?: string;
}

export interface WakeState {
  lastRunAt?: string;
  lastWakes?: number;
  lastDelivered?: number;
  lastError?: string;
  status?: string[];
  /** By session: the last wake sent that has not reached the session yet. */
  open?: Record<string, { at: string; message: string }>;
}

/** The wake runners from wakes.json (SHEPHERD_WAKES_CONFIG overrides the path). No file: { enabled: false, runners: [] }. */
export function wakesConfig(file?: string): { enabled: boolean; runners: WakeRunner[] };
export function wakesFile(env?: Record<string, string | undefined>, home?: string): string;
export function runWakeRunners(stateDir: string, runners: WakeRunner[], runnerDeps: object, only?: Set<string>): Promise<Record<string, WakeState>>;
export function runnerDeps(deps: Deps, now: number): object;
/** Runs the runners that are due (each at its own everySeconds); due remembers the next run between passes. Returns the states of those that ran. */
export function runDueWakes(deps: Deps, runners: WakeRunner[], due: Map<string, number>, now?: number): Promise<Record<string, WakeState>>;
export function planWakes(runners: WakeRunner[]): Promise<{ name: string; error: string | null; status: string[]; wakes: { session: string | null; message: string; replaces: string | null }[] }[]>;
export function readWakeStates(stateDir: string): Record<string, WakeState>;
export function wakeStatusLines(runners: WakeRunner[], states: Record<string, WakeState>, now: number): string[];

export function stuckResumeFile(env?: Record<string, string | undefined>, home?: string): string;
/** The stuck-resume config from stuck-resume.json (SHEPHERD_STUCK_RESUME_CONFIG overrides the path). No file: { enabled: false }. */
export function stuckResumeConfig(file?: string): { enabled: boolean };
/** Every stuck session with what a resume would do now. Changes nothing. */
export function stuckPlan(listed: AppSessionRow[], deps: Deps, now?: number): { id: string; name: string; resume: boolean; why: string }[];
/** Sends one resume message to each stuck session whose loop stopped since it was last resumed. Returns how many the app took. */
export function resumeStuck(listed: AppSessionRow[], deps: Deps, now?: number, opts?: { send?: (id: string, text: string) => Promise<{ ok: boolean; error: string | null }> }): Promise<number>;

// Agent operations over the app's socket (src/operate.mjs). Each resolves to a plain result object, or rejects with ShepherdError.
export interface AgentOperation { ok?: boolean; error?: string | null; [key: string]: unknown }
export function sessions(deps: Deps, opts?: { state?: 'busy' | 'idle' | 'waiting' | 'stuck' }): Promise<{ summary: Record<string, number>; sessions: Record<string, unknown>[] }>;
export function session(deps: Deps, id: string): Promise<Record<string, unknown>>;
export function messages(deps: Deps, id: string, count?: number): Promise<Record<string, unknown>>;
export function send(deps: Deps, args: { session_id: string; message: string; delivery_mode?: 'immediate' | 'enqueue' }): Promise<AgentOperation>;
export function create(deps: Deps, args: { name?: string; project_id?: string; session_kind?: 'chat' | 'project'; workspace_type?: 'worktree' | 'branch'; branch_name?: string; kickoff?: { prompt?: string; mode?: 'interactive' | 'plan' | 'autopilot'; model?: string; agent?: string; reasoning_effort?: string; permission_mode?: 'allow-all' | 'manual' }; }): Promise<AgentOperation>;
export function answer(deps: Deps, args: { session_id: string; answer: string }): Promise<AgentOperation>;
export function plan(deps: Deps, args: { session_id: string; approved: boolean; selected_action?: string; feedback?: string }): Promise<AgentOperation>;
export function archiveSession(deps: Deps, args: { session_id: string; owner_asked?: boolean }): Promise<AgentOperation>;
export function show(deps: Deps, id: string): Promise<AgentOperation>;
export function automation(deps: Deps, args: { session_id: string; clear?: boolean; prompt?: string; interval?: string; run_at?: string; every_minutes?: number; schedule_hour?: number; schedule_minute?: number; schedule_day?: number; cron_expression?: string; name?: string }): Promise<AgentOperation>;
export function automationOf(deps: Deps, id: string): Promise<AgentOperation>;
export function workflows(deps: Deps): Promise<AgentOperation>;
export function runWorkflow(deps: Deps, id: string): Promise<AgentOperation>;
/** Listens for the questions and plans the app's sessions ask, and records them for answer and plan. */
export function listenPrompts(deps: Deps, opts?: { retryMs?: number; now?: () => number }): { stop(): void };
export function applyFrame(pending: Record<string, unknown>, frame: Record<string, unknown>, at: string): boolean;
