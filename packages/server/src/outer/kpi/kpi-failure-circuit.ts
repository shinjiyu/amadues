/**
 * KPI 失败熔断 — ADL KPI-MANAGER-LAYER.md §3.1 R7 + DIGITAL-EMPLOYEE-AUTONOMY.md §6.3
 *
 * 路线级（P2）：同一路线（goal 签名）连续失败 ≥ 阈值 → 只熔断该路线（blockedRoutes），
 * KPI 保持 active，SelfWorkPolicy 必须换独立方向。
 * 系统性（多路线合计连败 ≥ 阈值，或 burst 无 goal 无法分路线）→ KPI 置 paused +
 * IM 通知 + action-log；恢复需人工/Ops。
 */
import type { KpiRegistry, KpiRecord } from '../kpi-registry.js';
import type { InnerBrainRegistry } from '../inner-brain-registry.js';
import type { OuterToolContext } from '../outer-tools.js';
import { appendAutonomyActionLog } from '../autonomy-action-log.js';
import { analyzeConsecutiveFailureRoutes, type FailureRoute } from './kpi-burst-state.js';

/** R7 默认阈值：连续 3 次失败熔断 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

export interface TrippedKpi {
  kpiId: string;
  failures: number;
  lastError?: string;
}

export interface RouteBlockedKpi {
  kpiId: string;
  /** 达到阈值的失败路线（goal 签名） */
  routes: FailureRoute[];
}

export interface FailureCircuitSelection {
  /** 系统性失败 → pause KPI */
  tripped: TrippedKpi[];
  /** 单路线失败 → 仅熔断路线，KPI 保持 active */
  routeBlocked: RouteBlockedKpi[];
}

/**
 * 纯选择（无在跑 burst 才计）：
 * - 多路线（≥2 条）连败合计 ≥ 阈值 → 系统性 tripped；
 * - 单路线连败 ≥ 阈值且路线可识别（goal 非空）→ routeBlocked；
 * - 路线不可识别（goal 为空）→ 退回 KPI 级 tripped 兜底。
 */
export function selectFailureCircuit(
  kpiRegistry: KpiRegistry,
  registry: InnerBrainRegistry,
  threshold: number = DEFAULT_MAX_CONSECUTIVE_FAILURES,
): FailureCircuitSelection {
  const selection: FailureCircuitSelection = { tripped: [], routeBlocked: [] };
  if (!(threshold > 0)) return selection;

  for (const kpi of kpiRegistry.list({ status: 'active' })) {
    const running = registry
      .list()
      .some((t) => t.kpiId === kpi.kpiId && (t.status === 'RUNNING' || t.status === 'BLOCKED'));
    if (running) continue;

    const analysis = analyzeConsecutiveFailureRoutes(kpi, registry);
    if (analysis.totalFailures < threshold) continue;

    const identifiable = analysis.routes.filter((r) => r.route.length > 0);
    if (analysis.distinctRoutes >= 2 || identifiable.length === 0) {
      selection.tripped.push({
        kpiId: kpi.kpiId,
        failures: analysis.totalFailures,
        lastError: analysis.lastError,
      });
      continue;
    }

    const hot = identifiable.filter((r) => r.failures >= threshold);
    if (hot.length > 0) selection.routeBlocked.push({ kpiId: kpi.kpiId, routes: hot });
  }
  return selection;
}

/** 兼容入口：仅返回系统性 tripped（会被 pause 的那部分） */
export function selectTrippedKpis(
  kpiRegistry: KpiRegistry,
  registry: InnerBrainRegistry,
  threshold: number = DEFAULT_MAX_CONSECUTIVE_FAILURES,
): TrippedKpi[] {
  return selectFailureCircuit(kpiRegistry, registry, threshold).tripped;
}

/** 供 SelfWorkContext.blockedRoutes：列出所有 active KPI 当前被熔断的路线签名 */
export function listBlockedRoutes(
  kpiRegistry: KpiRegistry,
  registry: InnerBrainRegistry,
  threshold: number = DEFAULT_MAX_CONSECUTIVE_FAILURES,
): string[] {
  return selectFailureCircuit(kpiRegistry, registry, threshold).routeBlocked.flatMap((entry) =>
    entry.routes.map((r) => r.route),
  );
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
  routeBlocked: RouteBlockedKpi[];
}

function buildPauseReason(failures: number, lastError?: string): string {
  const tail = lastError ? `：${lastError.slice(0, 160)}` : '';
  return `连续 ${failures} 次失败已熔断${tail}`;
}

/**
 * 扫描 active KPI：
 * - 系统性失败 → pause + IM 通知 + action-log（reason=kpi_failure_circuit）；
 * - 单路线失败 → 仅 action-log 留痕（reason=kpi_route_circuit），不 pause 不打扰人。
 * 心跳每 tick 在续派前调用。
 */
export async function tripFailureCircuitBreakers(
  deps: FailureCircuitDeps,
): Promise<FailureCircuitResult> {
  const threshold = deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const { tripped, routeBlocked } = selectFailureCircuit(deps.kpiRegistry, deps.registry, threshold);

  for (const entry of routeBlocked) {
    appendAutonomyActionLog(deps.dataRoot, {
      at: new Date().toISOString(),
      dispatched: false,
      reason: 'kpi_route_circuit',
      detail: `${entry.kpiId} 路线熔断（不 pause KPI）：${entry.routes
        .map((r) => `${r.route.slice(0, 60)}×${r.failures}`)
        .join('; ')}`,
    });
  }

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

  return { tripped, routeBlocked };
}
