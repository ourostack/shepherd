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
  now(): number;
  sleep(ms: number): Promise<void>;
  sql(query: string): Promise<SessionRow[]>;
  history(id: string): History;
  historySize(id: string): number;
  exchange(messages: object[], opts?: { done?: (j: any, got: any[]) => boolean; keep?: (j: any) => boolean; waitMs?: number }): Promise<any[]>;
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

export function deps(options?: { copilotHome?: string }): Deps;
export function historyFile(copilotHome: string, id: string): string;
export function snapshot(deps: Deps, now?: number, skip?: string[]): Promise<Snapshot[]>;

export function exchange(copilotHome: string, messages: object[], opts?: { done?: (j: any, got: any[]) => boolean; keep?: (j: any) => boolean; waitMs?: number }): Promise<any[]>;
export function appReady(deps: Deps): Promise<boolean>;
export function sendTo(deps: Deps, id: string, prompt: string, waitMs?: number): Promise<{ ok: boolean; reply: string; error: string | null }>;
export function archive(deps: Deps, row: ArchiveRow, opts?: { keepWorktree?: boolean; waitMs?: number }): Promise<{ ok: boolean; session_id: string; error: string | null }>;
