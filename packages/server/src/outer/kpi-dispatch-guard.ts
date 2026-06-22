/**
 * KPI burst 派发守卫 — ADL KPI-MANAGER-LAYER.md（多 burst 并行）
 */
import type { InnerBrainRegistry, TaskRecord, TaskStatus } from './inner-brain-registry.js';
import type { KpiRecord, KpiRegistry } from './kpi-registry.js';
import {
  evaluateKpiAdvanceEligibility,
  findBlockingBurstForKpi,
  runningBurstCount,
} from './kpi/kpi-burst-state.js';

/** 仍占用 RUNNING 槽位的状态 */
export const LIVE_KPI_BURST_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'RUNNING',
  'BLOCKED',
]);

export function hasLiveWorkForKpi(registry: InnerBrainRegistry, kpiId: string): boolean {
  return registry.list().some(
    (t) => t.kpiId === kpiId && LIVE_KPI_BURST_STATUSES.has(t.status),
  );
}

/** @deprecated 使用 findBlockingBurstForKpi */
export function findLiveBurstForKpi(
  registry: InnerBrainRegistry,
  kpiId: string,
  excludeInstanceId?: string,
  _kpiRegistry?: KpiRegistry,
): TaskRecord | undefined {
  return findBlockingBurstForKpi(registry, kpiId, excludeInstanceId);
}

export interface KpiAutonomyDispatchDecision {
  ok: boolean;
  reason: string;
  liveInstanceId?: string;
}

/**
 * 是否应为 KPI 再派 burst（Ops / API）。
 * 允许多 burst 并行：有 RUNNING 时仍可在有系统容量时 ok。
 */
export function evaluateKpiAutonomyDispatch(
  kpiRegistry: KpiRegistry,
  registry: InnerBrainRegistry,
  kpiId: string,
  opts: { hasSystemCapacity?: boolean; maxParallelPerKpi?: number } = {},
): KpiAutonomyDispatchDecision {
  const kpi = kpiRegistry.get(kpiId);
  if (!kpi || kpi.status !== 'active') {
    return { ok: false, reason: 'kpi_not_active' };
  }

  const elig = evaluateKpiAdvanceEligibility(kpi, registry, {
    allowParallel: true,
    hasSystemCapacity: opts.hasSystemCapacity ?? true,
    maxParallelPerKpi: opts.maxParallelPerKpi,
  });

  if (!elig.eligible) {
    const blocking = findBlockingBurstForKpi(registry, kpiId);
    return {
      ok: false,
      reason: elig.reason === 'running' ? 'kpi_burst_in_flight' : elig.reason,
      ...(blocking ? { liveInstanceId: blocking.instanceId } : {}),
    };
  }

  return { ok: true, reason: elig.mode ?? 'next_burst' };
}

/** 任一 active KPI 有 RUNNING burst → 心跳 hold legacy LLM */
export function isKpiSprintInProgress(
  registry: InnerBrainRegistry,
  kpiRegistry: KpiRegistry,
): boolean {
  for (const kpi of kpiRegistry.list({ status: 'active' })) {
    if (runningBurstCount(kpi, registry) > 0) return true;
  }
  return false;
}
