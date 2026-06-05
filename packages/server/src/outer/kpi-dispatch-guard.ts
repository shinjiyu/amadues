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
  /** burst onExit 续跑时 registry 尚未标 DONE，需排除当前实例 */
  excludeInstanceId?: string,
): TaskRecord | undefined {
  return registry.list().find(
    (t) =>
      t.kpiId === kpiId &&
      LIVE_KPI_BURST_STATUSES.has(t.status) &&
      (excludeInstanceId == null || t.instanceId !== excludeInstanceId),
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
 * KPI 全力冲刺语义：同 KPI 已有 RUNNING/AWAITING/BLOCKED 在途 burst 时 **不再** 并行派发；
 * 等当前 burst 结束后再由 idle streak / reflexion 路径续派下一条。
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

  const live = findLiveBurstForKpi(registry, kpiId);
  if (live) {
    return {
      ok: false,
      reason: 'kpi_burst_in_flight',
      liveInstanceId: live.instanceId,
    };
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

  return { ok: true, reason: 'next_burst' };
}

/** 任一 active KPI 仍有在途 burst → 心跳应 hold（不派新 burst、跳过 legacy LLM 心跳） */
export function isKpiSprintInProgress(
  registry: InnerBrainRegistry,
  kpiRegistry: KpiRegistry,
): boolean {
  return kpiRegistry.list({ status: 'active' }).some((kpi) => hasLiveWorkForKpi(registry, kpi.kpiId));
}
