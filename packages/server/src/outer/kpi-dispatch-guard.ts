/**
 * KPI burst 派发去重：避免心跳/autonomy/外脑 LLM 重复 set_goal 同一 KPI。
 */
import type { InnerBrainRegistry, TaskRecord, TaskStatus } from './inner-brain-registry.js';
import type { KpiRegistry } from './kpi-registry.js';
import { buildKpiBurstLinks, suggestKpiAction } from './kpi-progress.js';

/** 仍占用 KPI 推进槽位的内脑状态（DONE/STOPPED/ERROR 可再派） */
export const LIVE_KPI_BURST_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'RUNNING',
  'AWAITING',
  'BLOCKED',
]);

export function hasLiveWorkForKpi(registry: InnerBrainRegistry, kpiId: string): boolean {
  return findLiveBurstForKpi(registry, kpiId) != null;
}

export function findLiveBurstForKpi(
  registry: InnerBrainRegistry,
  kpiId: string,
): TaskRecord | undefined {
  return registry.list().find(
    (t) => t.kpiId === kpiId && LIVE_KPI_BURST_STATUSES.has(t.status),
  );
}

export interface KpiAutonomyDispatchDecision {
  ok: boolean;
  reason: string;
  liveInstanceId?: string;
}

/**
 * autonomy 定时器是否应为该 KPI 再派一发 burst。
 *
 * 并行语义（relax_parallel）：不再因「已有在途 burst」一票否决。容量是否充足由调用方的
 * `canSpawnInner`（running/awaiting 槽位）负责；本函数只判断 KPI 自身语义——已达成、
 * idle 卡死该转反思等。这样在某 burst 正 RUNNING/AWAITING 时，只要槽位没满，仍可派发
 * **不重复角度**的新 burst（去重靠注入的在途任务上下文让规划器自行规避）。
 */
export function evaluateKpiAutonomyDispatch(
  kpiRegistry: KpiRegistry,
  registry: InnerBrainRegistry,
  kpiId: string,
): KpiAutonomyDispatchDecision {
  const kpi = kpiRegistry.get(kpiId);
  if (!kpi || kpi.status !== 'active') {
    return { ok: false, reason: 'kpi_not_active' };
  }

  if (kpi.bursts.length === 0) {
    return { ok: true, reason: 'first_burst' };
  }

  // idle 卡死优先转反思，不再派新真任务
  const threshold = Math.max(1, Number(process.env['UTLRA_KPI_STUCK_THRESHOLD'] ?? 3));
  if (kpi.consecutiveIdleBursts >= threshold) {
    return {
      ok: false,
      reason: `kpi_stuck_reflexion:连续 ${kpi.consecutiveIdleBursts} 次 idle 无产出`,
    };
  }

  const links = buildKpiBurstLinks(kpi, registry);
  const { action, reason } = suggestKpiAction(kpi, links);
  if (action === 'achieved') {
    return { ok: false, reason: `kpi_${action}:${reason}` };
  }

  // continue / follow_up / sub-threshold streak 均允许并行派发（容量由 canSpawnInner 把关）
  const live = findLiveBurstForKpi(registry, kpiId);
  return {
    ok: true,
    reason: live ? 'parallel_next_burst' : 'next_burst',
    ...(live ? { liveInstanceId: live.instanceId } : {}),
  };
}
