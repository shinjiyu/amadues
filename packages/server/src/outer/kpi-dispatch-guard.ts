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
 * 在途 burst、等待输入、阻塞跟进、反思续跑等场景一律 skip。
 */
export function evaluateKpiAutonomyDispatch(
  kpiRegistry: KpiRegistry,
  registry: InnerBrainRegistry,
  kpiId: string,
): KpiAutonomyDispatchDecision {
  const live = findLiveBurstForKpi(registry, kpiId);
  if (live) {
    return {
      ok: false,
      reason: 'kpi_burst_in_progress',
      liveInstanceId: live.instanceId,
    };
  }

  const kpi = kpiRegistry.get(kpiId);
  if (!kpi || kpi.status !== 'active') {
    return { ok: false, reason: 'kpi_not_active' };
  }

  if (kpi.bursts.length === 0) {
    return { ok: true, reason: 'first_burst' };
  }

  const links = buildKpiBurstLinks(kpi, registry);
  const { action, reason } = suggestKpiAction(kpi, links);
  if (action === 'continue' || action === 'follow_up' || action === 'achieved') {
    return { ok: false, reason: `kpi_${action}:${reason}` };
  }
  if (action === 'stuck_reflexion') {
    return { ok: false, reason: `kpi_stuck_reflexion:${reason}` };
  }

  return { ok: true, reason: 'ok' };
}
