/**
 * 僵尸 burst 清理 — ADL KPI-MANAGER-LAYER.md §3.1 R5（原 staleBurstReaper，自 strategy/ 迁入）
 */
import type { TaskRecord } from '../inner-brain-registry.js';
import type { StaleAwaitingPolicy } from './kpi-awaiting-policy.js';

export interface CullDirective {
  burstInstanceId: string;
  reason: string;
  grace: 'now' | 'warn_in_im_then_kill';
}

export interface StaleAwaitingHit {
  instanceId: string;
  awaitingMs: number;
}

function awaitingSince(t: TaskRecord): number {
  const ref = t.lastTickAt ?? t.startedAt;
  const ms = Date.parse(ref);
  return Number.isFinite(ms) ? ms : Date.now();
}

export function selectStaleAwaiting(
  tasks: TaskRecord[],
  policy: StaleAwaitingPolicy,
  now = Date.now(),
): StaleAwaitingHit[] {
  const hits: StaleAwaitingHit[] = [];
  for (const t of tasks) {
    if (t.status !== 'AWAITING') continue;
    const awaitingMs = now - awaitingSince(t);
    if (awaitingMs > policy.maxAwaitingMs) hits.push({ instanceId: t.instanceId, awaitingMs });
  }
  return hits;
}

export function selectNeedsReview(
  tasks: TaskRecord[],
  policy: StaleAwaitingPolicy,
  now = Date.now(),
): string[] {
  const out: string[] = [];
  for (const t of tasks) {
    if (t.status !== 'AWAITING') continue;
    const awaitingMs = now - awaitingSince(t);
    if (awaitingMs > policy.requireProgressSignalAfterMs && awaitingMs <= policy.maxAwaitingMs) {
      out.push(t.instanceId);
    }
  }
  return out;
}

export interface ReaperDeps {
  getTask: (instanceId: string) => TaskRecord | undefined;
  peekPendingMatch?: (instanceId: string) => boolean;
  killProcess?: (pid: number) => void | Promise<void>;
  archive?: (task: TaskRecord, reason: string) => void | Promise<void>;
  abort: (
    instanceId: string,
    patch: { abortReason: string; abortedBy: 'strategy_reflect' | 'stale_awaiting_timeout'; abortedAt: string },
  ) => void;
  appendActionLog?: (entry: {
    kind: 'cull_burst';
    burstId: string;
    reason: string;
    reaper: 'strategy' | 'timeout';
    at: string;
  }) => void;
  now?: () => number;
}

export interface ReapOutcome {
  abortedIds: string[];
  skippedPending: string[];
}

export async function reap(
  cullDirectives: CullDirective[],
  staleHits: StaleAwaitingHit[],
  deps: ReaperDeps,
): Promise<ReapOutcome> {
  const now = () => new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const abortedIds: string[] = [];
  const skippedPending: string[] = [];

  const doAbort = async (
    instanceId: string,
    reason: string,
    abortedBy: 'strategy_reflect' | 'stale_awaiting_timeout',
    reaper: 'strategy' | 'timeout',
  ): Promise<void> => {
    const task = deps.getTask(instanceId);
    if (!task) return;
    if (task.status === 'ABORTED' || task.status === 'DONE' || task.status === 'STOPPED') return;
    if (deps.peekPendingMatch?.(instanceId)) {
      skippedPending.push(instanceId);
      return;
    }
    if (typeof task.pid === 'number' && deps.killProcess) {
      try {
        await deps.killProcess(task.pid);
      } catch {
        /* 进程可能已死 */
      }
    }
    if (deps.archive) {
      try {
        await deps.archive(task, reason);
      } catch {
        /* archive 失败不阻断 ABORTED 迁移 */
      }
    }
    const at = now();
    deps.abort(instanceId, { abortReason: reason, abortedBy, abortedAt: at });
    deps.appendActionLog?.({ kind: 'cull_burst', burstId: instanceId, reason, reaper, at });
    abortedIds.push(instanceId);
  };

  for (const d of cullDirectives) {
    if (d.grace !== 'now') continue;
    await doAbort(d.burstInstanceId, d.reason, 'strategy_reflect', 'strategy');
  }
  for (const hit of staleHits) {
    await doAbort(hit.instanceId, 'stale_awaiting_timeout', 'stale_awaiting_timeout', 'timeout');
  }

  return { abortedIds, skippedPending };
}
