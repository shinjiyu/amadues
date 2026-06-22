/**
 * @deprecated 使用 evaluateKpiAdvanceEligibility（kpi-burst-state.ts）
 */
import type { InnerBrainRegistry } from '../inner-brain-registry.js';
import type { KpiRecord } from '../kpi-registry.js';
import { evaluateKpiAdvanceEligibility } from './kpi-burst-state.js';

export interface KpiSlotIdleResult {
  idle: boolean;
  reason: string;
}

export function evaluateKpiSlotIdle(
  kpi: KpiRecord,
  registry: InnerBrainRegistry,
): KpiSlotIdleResult {
  const e = evaluateKpiAdvanceEligibility(kpi, registry, {
    allowParallel: false,
    hasSystemCapacity: false,
  });
  return {
    idle: e.eligible,
    reason: e.reason,
  };
}

export function isKpiSlotIdle(
  kpi: KpiRecord,
  registry: InnerBrainRegistry,
): boolean {
  return evaluateKpiSlotIdle(kpi, registry).idle;
}
