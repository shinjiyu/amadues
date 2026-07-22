/**
 * 同 KPI 多 burst 状态与推进资格 — ADL KPI-MANAGER-LAYER.md §2–§3
 *
 * 调度：idle 心跳 + eligibility（无 cadence；定时由 burst 内 AWAITING/wait_timer + changeWatcher 承担）
 */
import { buildBrainAsyncSnapshot } from '../brain-async-snapshot.js';
import type { InnerBrainRegistry, TaskRecord, TaskStatus } from '../inner-brain-registry.js';
import type { KpiRecord } from '../kpi-registry.js';
import { buildKpiBurstLinks, suggestKpiAction } from '../kpi-progress.js';

const RUNNING_STATUSES: ReadonlySet<TaskStatus> = new Set(['RUNNING', 'BLOCKED']);

export function listBurstsForKpi(kpi: KpiRecord, registry: InnerBrainRegistry): TaskRecord[] {
  const out: TaskRecord[] = [];
  const seen = new Set<string>();
  for (const id of kpi.bursts) {
    if (seen.has(id)) continue;
    seen.add(id);
    const rec = registry.get(id);
    if (rec && rec.kpiId === kpi.kpiId) out.push(rec);
  }
  return out;
}

export function runningBurstCount(kpi: KpiRecord, registry: InnerBrainRegistry): number {
  return listBurstsForKpi(kpi, registry).filter((r) => RUNNING_STATUSES.has(r.status)).length;
}

/** 诊断用途：列出 KPI 内仍在等人类的依赖；不得作为整个 KPI 的派发 gate。 */
export function hasBlockingAskUserForKpi(kpi: KpiRecord, registry: InnerBrainRegistry): boolean {
  for (const rec of listBurstsForKpi(kpi, registry)) {
    if (rec.status !== 'AWAITING') continue;
    if (buildBrainAsyncSnapshot(rec.workDir).has_ask_user_pending) return true;
  }
  return false;
}

/** 失败终态（R7 熔断计数）：ERROR / ABORTED 视为失败 */
const FAILURE_STATUSES: ReadonlySet<TaskStatus> = new Set(['ERROR', 'ABORTED']);
/** 成功/非失败终态（打断连败计数）：DONE / AWAITING / STOPPED */
const NON_FAILURE_TERMINAL: ReadonlySet<TaskStatus> = new Set(['DONE', 'AWAITING', 'STOPPED']);

/**
 * 统计 KPI 末尾**连续失败**的 burst 数（R7 熔断）。
 * - 按 startedAt 倒序遍历该 KPI 的 burst；
 * - RUNNING/BLOCKED（在跑）跳过不计、不打断；
 * - ERROR/ABORTED → 计数；遇到 DONE/AWAITING/STOPPED（有进展/等待）即停止计数。
 */
export function countConsecutiveBurstFailures(
  kpi: KpiRecord,
  registry: InnerBrainRegistry,
): { failures: number; lastError?: string } {
  const bursts = listBurstsForKpi(kpi, registry).sort((a, b) =>
    (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
  );
  let failures = 0;
  let lastError: string | undefined;
  for (const rec of bursts) {
    if (rec.status === 'RUNNING' || rec.status === 'BLOCKED') continue;
    if (FAILURE_STATUSES.has(rec.status)) {
      failures++;
      if (!lastError) lastError = rec.errorMessage ?? rec.abortReason;
      continue;
    }
    if (NON_FAILURE_TERMINAL.has(rec.status)) break;
  }
  return { failures, lastError };
}

/** 路线签名（与 self-work-policy.routeSignature 同构；本模块零依赖故内联） */
function routeKey(goal: string): string {
  return goal.trim().toLocaleLowerCase().replace(/\s+/g, ' ').slice(0, 240);
}

export interface FailureRoute {
  route: string;
  failures: number;
  lastError?: string;
}

export interface ConsecutiveFailureRoutes {
  totalFailures: number;
  lastError?: string;
  routes: FailureRoute[];
  distinctRoutes: number;
}

/**
 * R7 路线级失败分析（ADL DIGITAL-EMPLOYEE-AUTONOMY.md §6.3）：
 * 对末尾连续失败窗口按 burst goal 的路线签名分组。
 * - 同路线连败 ≥ 阈值 → 只熔断该路线（blockedRoutes），不 pause KPI；
 * - 多路线（distinctRoutes ≥ 2）合计连败 ≥ 阈值 → 系统性失败，KPI pause。
 * 窗口被 DONE/AWAITING/STOPPED 打断即自愈，无需持久化熔断状态。
 */
export function analyzeConsecutiveFailureRoutes(
  kpi: KpiRecord,
  registry: InnerBrainRegistry,
): ConsecutiveFailureRoutes {
  const bursts = listBurstsForKpi(kpi, registry).sort((a, b) =>
    (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
  );
  const byRoute = new Map<string, FailureRoute>();
  let totalFailures = 0;
  let lastError: string | undefined;
  for (const rec of bursts) {
    if (rec.status === 'RUNNING' || rec.status === 'BLOCKED') continue;
    if (FAILURE_STATUSES.has(rec.status)) {
      totalFailures++;
      const err = rec.errorMessage ?? rec.abortReason;
      if (!lastError) lastError = err;
      const route = routeKey(rec.goal ?? '');
      const entry = byRoute.get(route) ?? { route, failures: 0 };
      entry.failures++;
      if (!entry.lastError) entry.lastError = err;
      byRoute.set(route, entry);
      continue;
    }
    if (NON_FAILURE_TERMINAL.has(rec.status)) break;
  }
  return {
    totalFailures,
    lastError,
    routes: [...byRoute.values()],
    distinctRoutes: byRoute.size,
  };
}

export type KpiAdvanceMode = 'first' | 'continue' | 'parallel';

export interface KpiAdvanceEligibility {
  eligible: boolean;
  reason: string;
  mode?: KpiAdvanceMode;
}

/**
 * 是否可为 KPI 再开 burst（心跳 tick 即时决策，无 cadence 层）。
 * - 无 burst → first（R1 首发）
 * - 无 RUNNING → continue（R1 续派）
 * - 有 RUNNING 且系统有槽 → parallel（R2）
 */
export function evaluateKpiAdvanceEligibility(
  kpi: KpiRecord,
  registry: InnerBrainRegistry,
  opts: {
    allowParallel?: boolean;
    hasSystemCapacity?: boolean;
    maxParallelPerKpi?: number;
    /** R7：连续失败 ≥ 此值 → 不再续派（0/未给 = 不启用此 gate） */
    maxConsecutiveFailures?: number;
  } = {},
): KpiAdvanceEligibility {
  const allowParallel = opts.allowParallel ?? true;
  const hasSystemCapacity = opts.hasSystemCapacity ?? true;
  const maxParallelPerKpi = opts.maxParallelPerKpi ?? 1;

  if (kpi.status !== 'active') {
    return { eligible: false, reason: 'not_active' };
  }

  const bursts = listBurstsForKpi(kpi, registry);
  const running = runningBurstCount(kpi, registry);

  // R7：连续失败熔断（仅当无在跑 burst 时计入；在跑时不阻断已派的）
  if (opts.maxConsecutiveFailures && opts.maxConsecutiveFailures > 0 && running === 0) {
    const { failures } = countConsecutiveBurstFailures(kpi, registry);
    if (failures >= opts.maxConsecutiveFailures) {
      return { eligible: false, reason: 'kpi_failure_circuit' };
    }
  }

  if (bursts.length > 0) {
    const links = buildKpiBurstLinks(kpi, registry);
    const { action } = suggestKpiAction(kpi, links);
    if (action === 'achieved') {
      return { eligible: false, reason: 'kpi_achieved' };
    }
  }

  if (bursts.length === 0) {
    return { eligible: true, reason: 'first_burst', mode: 'first' };
  }

  if (running === 0) {
    return { eligible: true, reason: 'continue', mode: 'continue' };
  }

  if (running >= maxParallelPerKpi) {
    return { eligible: false, reason: 'kpi_parallel_cap' };
  }

  if (allowParallel && hasSystemCapacity) {
    return { eligible: true, reason: 'parallel', mode: 'parallel' };
  }

  return { eligible: false, reason: 'running' };
}

/** 用于闲聊 defer：有 RUNNING/BLOCKED 或 ask_user AWAITING 的 burst */
export function findBlockingBurstForKpi(
  registry: InnerBrainRegistry,
  kpiId: string,
  excludeInstanceId?: string,
): TaskRecord | undefined {
  return registry.list().find(
    (t) =>
      t.kpiId === kpiId &&
      (t.status === 'RUNNING' ||
        t.status === 'BLOCKED' ||
        (t.status === 'AWAITING' &&
          buildBrainAsyncSnapshot(t.workDir).has_ask_user_pending)) &&
      (excludeInstanceId == null || t.instanceId !== excludeInstanceId),
  );
}
