/**
 * per-leaf KPI burst 复用与抢占 — ADL KPI-ADVANCEMENT.md §4–§5
 */
import type { InnerBrainRegistry, TaskRecord } from '../inner-brain-registry.js';
import type { KpiRecord, KpiRegistry } from '../kpi-registry.js';
import { findCanonicalBurstForKpi } from '../inner-brain-kpi-reuse.js';
import { evaluateKpiSlotIdle } from './kpi-slot-idle.js';

export function findCanonicalForLeafKpi(
  kpi: KpiRecord,
  innerBrainRegistry: InnerBrainRegistry,
  kpiRegistry: KpiRegistry,
): TaskRecord | undefined {
  if (kpi.canonicalInstanceId) {
    const rec = innerBrainRegistry.get(kpi.canonicalInstanceId);
    if (rec && rec.kpiId === kpi.kpiId) return rec;
  }
  return findCanonicalBurstForKpi(innerBrainRegistry, kpiRegistry, kpi.kpiId);
}

/** 推进前是否需要抢占 AWAITING（timer，非 ask_user） */
export function needsPreemptForAdvance(
  kpi: KpiRecord,
  registry: InnerBrainRegistry,
): TaskRecord | undefined {
  const slot = evaluateKpiSlotIdle(kpi, registry);
  if (slot.reason !== 'awaiting_timer_due') return undefined;
  const instanceId = kpi.canonicalInstanceId ?? kpi.bursts[kpi.bursts.length - 1];
  if (!instanceId) return undefined;
  const rec = registry.get(instanceId);
  if (rec?.status === 'AWAITING') return rec;
  return undefined;
}
