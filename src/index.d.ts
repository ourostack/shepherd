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

export function readTail(file: string, bytes?: number): string[];
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
export function sendTo(deps: Deps, id: string, prompt: string, waitMs?: number): Promise<{ ok: boolean; reply: string; error: string | null }>;
/** Once the app confirms, compresses the session's history (unless compress is false); compressed is null otherwise. */
export function archive(deps: Deps, row: ArchiveRow, opts?: { keepWorktree?: boolean; waitMs?: number; compress?: boolean }): Promise<{ ok: boolean; session_id: string; error: string | null; compressed: CompressResult | null }>;
export function compressHistory(deps: Deps, id: string, opts?: { dryRun?: boolean }): Promise<CompressResult>;
export function restoreHistory(deps: Deps, id: string): Promise<RestoreResult>;

export function pickTargets(o: { before: Snapshot[]; after: Snapshot[]; also?: string[] }): ResumeTarget[];
export function resumeText(o: { at: number; why?: string | null; lanes?: { lanes?: number; minutes?: number | null } | null }): string;
/** Sends one resume message to each target and waits for a turn. Writes <state>/resume-last.json when anything resumed. */
export function resume(
  deps: Deps & { heldBack?: (held: { id: string; title: string | null; bytes: number }[]) => void },
  o: { targets: ResumeTarget[]; startedAt: number; restartedAt: number; why?: string | null; lanes?: Map<string, { lanes?: number; minutes?: number | null }>; t?: Partial<ResumeTiming>; log?: (line: string) => void },
): Promise<ResumeResult[]>;
