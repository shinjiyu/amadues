/**
 * KPI 失败熔断 — ADL KPI-MANAGER-LAYER.md §3.1 R7
 *
 * 同 KPI 连续 burst 失败（ERROR/ABORTED）≥ 阈值 → KPI 置 paused + IM 通知 + action-log；
 * 停止心跳续派（paused → evaluateKpiAdvanceEligibility 返回 not_active）。恢复需人工/Ops。
 */
import type { KpiRegistry, KpiRecord } from '../kpi-registry.js';
import type { InnerBrainRegistry } from '../inner-brain-registry.js';
import type { OuterToolContext } from '../outer-tools.js';
import { appendAutonomyActionLog } from '../autonomy-action-log.js';
import { countConsecutiveBurstFailures } from './kpi-burst-state.js';

/** R7 默认阈值：连续 3 次失败熔断 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export interface TrippedKpi {
  kpiId: string;
  failures: number;
  lastError?: string;
}

/** 纯选择：哪些 active KPI 已达连续失败阈值（无在跑 burst 才计） */
export function selectTrippedKpis(
  kpiRegistry: KpiRegistry,
  registry: InnerBrainRegistry,
  threshold: number = DEFAULT_MAX_CONSECUTIVE_FAILURES,
): TrippedKpi[] {
  if (!(threshold > 0)) return [];
  const out: TrippedKpi[] = [];
  for (const kpi of kpiRegistry.list({ status: 'active' })) {
    const running = registry
      .list()
      .some((t) => t.kpiId === kpi.kpiId && (t.status === 'RUNNING' || t.status === 'BLOCKED'));
    if (running) continue;
    const { failures, lastError } = countConsecutiveBurstFailures(kpi, registry);
    if (failures >= threshold) out.push({ kpiId: kpi.kpiId, failures, lastError });
  }
  return out;
}

export interface FailureCircuitDeps {
  dataRoot: string;
  kpiRegistry: KpiRegistry;
  registry: InnerBrainRegistry;
  toolCtx: OuterToolContext;
  defaultThreadId: string;
  maxConsecutiveFailures?: number;
}

export interface FailureCircuitResult {
  tripped: TrippedKpi[];
}

function buildPauseReason(failures: number, lastError?: string): string {
  const tail = lastError ? `：${lastError.slice(0, 160)}` : '';
  return `连续 ${failures} 次失败已熔断${tail}`;
}

/**
 * 扫描 active KPI，对达阈值者 pause + IM 通知 + action-log。
 * 心跳每 tick 在续派前调用，确保熔断的 KPI 不再被 advancer 选中。
 */
export async function tripFailureCircuitBreakers(
  deps: FailureCircuitDeps,
): Promise<FailureCircuitResult> {
  const threshold = deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const tripped = selectTrippedKpis(deps.kpiRegistry, deps.registry, threshold);

  for (const t of tripped) {
    const kpi: KpiRecord | undefined = deps.kpiRegistry.get(t.kpiId);
    const reason = buildPauseReason(t.failures, t.lastError);
    deps.kpiRegistry.pause(t.kpiId, reason);

    appendAutonomyActionLog(deps.dataRoot, {
      at: new Date().toISOString(),
      dispatched: false,
      reason: 'kpi_failure_circuit',
      detail: `${t.kpiId} ${reason}`,
    });

    try {
      const desc = kpi?.description?.slice(0, 60) ?? t.kpiId;
      await deps.toolCtx.imClient.postMessage(deps.defaultThreadId, {
        sender_sid: deps.toolCtx.agentSid,
        text:
          `⚠️ KPI「${desc}」连续 ${t.failures} 次失败，已自动暂停。` +
          `${t.lastError ? `最近错误：${t.lastError.slice(0, 120)}。` : ''}` +
          `回复「继续 ${t.kpiId}」可重试。`,
        parse_mentions: true,
      });
    } catch {
      // IM 通知失败不致命；已 pause + action-log 留痕
    }
  }

  return { tripped };
}
