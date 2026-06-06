/**
 * 战略规划层 — staleBurstReaper（ADL STRATEGY-PLANNING-LAYER.md §9）。
 *
 * P0：静态超时兜底 + cullDirectives（grace='now'）执行。杀死 = 经 ABORTED 状态迁移 + archive，**绝不** `rm`。
 *   - peekPendingMatch：即将醒来的 AWAITING 本 tick 跳过
 *   - killProcess：SIGTERM→（graceMs）→SIGKILL，注入便于测试
 *   - registry.update(status='ABORTED', abortReason, abortedBy, abortedAt)
 *   - appendActionLog：{ kind:'cull_burst', ... } 给 Dashboard / 审计
 *
 * 选择逻辑为纯函数；副作用（kill / update / log）经注入依赖，单测用 fake。
 */
import type { TaskRecord } from '../inner-brain-registry.js';
import type { CullDirective, StaleAwaitingPolicy } from './strategy-types.js';

export interface StaleAwaitingHit {
  instanceId: string;
  awaitingMs: number;
}

/** AWAITING 参照时刻：lastTickAt 优先（最近活动），无则 startedAt */
function awaitingSince(t: TaskRecord): number {
  const ref = t.lastTickAt ?? t.startedAt;
  const ms = Date.parse(ref);
  return Number.isFinite(ms) ? ms : Date.now();
}

/** 超 maxAwaitingMs 的 AWAITING 任务（静态兜底候选） */
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

/** 超 requireProgressSignalAfterMs（但未到硬上限）的 AWAITING：不杀，置位复审 */
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
  /** 读 registry 当前任务（含 status / pid） */
  getTask: (instanceId: string) => TaskRecord | undefined;
  /** 即将匹配醒来 → true 则本 tick 跳过 */
  peekPendingMatch?: (instanceId: string) => boolean;
  /** 终止 worker（SIGTERM→SIGKILL）；缺省为 no-op（已无活进程时） */
  killProcess?: (pid: number) => void | Promise<void>;
  /** archive：让被杀 burst 仍产 reflexion 供下轮 reflect */
  archive?: (task: TaskRecord, reason: string) => void | Promise<void>;
  /** 写 registry ABORTED 迁移 */
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

/**
 * 执行一轮收割：先 cullDirectives（grace='now'），再静态超时兜底。
 * grace='warn_in_im_then_kill' 属 P1，本轮跳过（留给 P1 grace 流程）。
 */
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
    if (d.grace !== 'now') continue; // warn_in_im_then_kill 属 P1
    await doAbort(d.burstInstanceId, d.reason, 'strategy_reflect', 'strategy');
  }
  for (const hit of staleHits) {
    await doAbort(hit.instanceId, 'stale_awaiting_timeout', 'stale_awaiting_timeout', 'timeout');
  }

  return { abortedIds, skippedPending };
}
