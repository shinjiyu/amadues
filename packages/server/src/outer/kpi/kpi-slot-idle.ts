/**
 * ongoing leaf KPI 槽位空闲判定 — ADL KPI-ADVANCEMENT.md §5
 */
import { buildBrainAsyncSnapshot } from '../brain-async-snapshot.js';
import type { InnerBrainRegistry } from '../inner-brain-registry.js';
import type { KpiRecord } from '../kpi-registry.js';
import { isCadenceDue } from './kpi-cadence.js';

export interface KpiSlotIdleResult {
  idle: boolean;
  reason: string;
  /** cadence 未到但槽位已空 */
  cadenceDue: boolean;
}

/**
 * 叶子 KPI 是否可再派 sprint。
 * ongoing：DONE / AWAITING（无 ask_user）= 槽位空闲。
 * delivery once：无在途 RUNNING/BLOCKED 且 cadence due。
 */
export function evaluateKpiSlotIdle(
  kpi: KpiRecord,
  registry: InnerBrainRegistry,
  nowMs: number = Date.now(),
): KpiSlotIdleResult {
  if (!kpi.isLeaf || kpi.status !== 'active') {
    return { idle: false, reason: 'not_active_leaf', cadenceDue: false };
  }

  const cadenceDue = isCadenceDue(kpi, nowMs);
  const instanceId = kpi.canonicalInstanceId ?? kpi.bursts[kpi.bursts.length - 1];
  if (!instanceId) {
    return { idle: true, reason: 'no_burst_yet', cadenceDue: true };
  }

  const rec = registry.get(instanceId);
  if (!rec) {
    return { idle: true, reason: 'canonical_missing', cadenceDue };
  }

  if (rec.status === 'RUNNING') {
    return { idle: false, reason: 'running', cadenceDue };
  }
  if (rec.status === 'BLOCKED') {
    return { idle: false, reason: 'blocked', cadenceDue };
  }

  if (rec.status === 'AWAITING') {
    const snap = buildBrainAsyncSnapshot(rec.workDir);
    if (snap.has_ask_user_pending) {
      return { idle: false, reason: 'awaiting_human', cadenceDue };
    }
    // ongoing：timer AWAITING 不占槽
    if (kpi.kind === 'ongoing') {
      return {
        idle: cadenceDue,
        reason: cadenceDue ? 'awaiting_timer_due' : 'awaiting_timer_not_due',
        cadenceDue,
      };
    }
    return { idle: false, reason: 'awaiting', cadenceDue };
  }

  if (rec.status === 'DONE' || rec.status === 'STOPPED' || rec.status === 'ERROR' || rec.status === 'ABORTED') {
    return {
      idle: cadenceDue,
      reason: cadenceDue ? `${rec.status.toLowerCase()}_due` : `${rec.status.toLowerCase()}_not_due`,
      cadenceDue,
    };
  }

  return { idle: false, reason: `status_${rec.status}`, cadenceDue };
}

export function isKpiSlotIdle(
  kpi: KpiRecord,
  registry: InnerBrainRegistry,
  nowMs?: number,
): boolean {
  return evaluateKpiSlotIdle(kpi, registry, nowMs).idle;
}
