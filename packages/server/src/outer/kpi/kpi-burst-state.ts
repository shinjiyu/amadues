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

/** 任一 burst 在等人类 → 暂缓自动续派（R4 超时由 kpi-awaiting-review 处理） */
export function hasBlockingAskUserForKpi(kpi: KpiRecord, registry: InnerBrainRegistry): boolean {
  for (const rec of listBurstsForKpi(kpi, registry)) {
    if (rec.status !== 'AWAITING') continue;
    if (buildBrainAsyncSnapshot(rec.workDir).has_ask_user_pending) return true;
  }
  return false;
}

export type KpiAdvanceMode = 'first' | 'continue' | 'parallel';

export interface KpiAdvanceEligibility {
  eligible: boolean;
  reason: string;
  mode?: KpiAdvanceMode;
}

/**
 * 是否可为 KPI 再开 burst（心跳 tick 即时决策，无 cadence 层）。
 * - 无 burst → first（R1 首 sprint）
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

  if (hasBlockingAskUserForKpi(kpi, registry)) {
    return { eligible: false, reason: 'awaiting_human' };
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
