/**
 * KPI burst 派发去重：避免心跳/autonomy/外脑 LLM 重复 set_goal 同一 KPI。
 * ongoing leaf：DONE/AWAITING(timer) 不占槽 — 见 KPI-ADVANCEMENT.md §5。
 */
import type { InnerBrainRegistry, TaskRecord, TaskStatus } from './inner-brain-registry.js';
import type { KpiRecord, KpiRegistry } from './kpi-registry.js';
import { buildKpiBurstLinks, suggestKpiAction } from './kpi-progress.js';
import { isCadenceDue } from './kpi/kpi-cadence.js';
import { isKpiSlotIdle } from './kpi/kpi-slot-idle.js';

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
  kpiRegistry?: KpiRegistry,
): TaskRecord | undefined {
  const kpi = kpiRegistry?.get(kpiId);
  if (kpi?.isLeaf && kpi.kind === 'ongoing') {
    const blocking = findBlockingBurstForLeafKpi(kpi, registry, excludeInstanceId);
    if (blocking) return blocking;
    return undefined;
  }
  return registry.list().find(
    (t) =>
      t.kpiId === kpiId &&
      LIVE_KPI_BURST_STATUSES.has(t.status) &&
      (excludeInstanceId == null || t.instanceId !== excludeInstanceId),
  );
}

/** ongoing leaf：仅 RUNNING / BLOCKED / AWAITING+ask_user 占槽 */
export function findBlockingBurstForLeafKpi(
  kpi: KpiRecord,
  registry: InnerBrainRegistry,
  excludeInstanceId?: string,
): TaskRecord | undefined {
  const instanceId = kpi.canonicalInstanceId ?? kpi.bursts[kpi.bursts.length - 1];
  if (!instanceId) return undefined;
  if (excludeInstanceId && instanceId === excludeInstanceId) return undefined;
  const rec = registry.get(instanceId);
  if (!rec || rec.kpiId !== kpi.kpiId) return undefined;
  if (rec.status === 'RUNNING' || rec.status === 'BLOCKED') return rec;
  if (rec.status === 'AWAITING' && !isKpiSlotIdle(kpi, registry)) return rec;
  return undefined;
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

  // 父 KPI：看子 leaf 是否可推进
  if (!kpi.isLeaf && kpi.children?.length) {
    for (const cid of kpi.children) {
      const child = kpiRegistry.get(cid);
      if (!child || child.status !== 'active') continue;
      const childDecision = evaluateKpiAutonomyDispatch(kpiRegistry, registry, cid);
      if (childDecision.ok) return { ok: true, reason: 'child_next_burst' };
    }
    return { ok: false, reason: 'parent_no_child_ready' };
  }

  const live = findLiveBurstForKpi(registry, kpiId, undefined, kpiRegistry);
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

  if (kpi.isLeaf && kpi.kind === 'ongoing' && !isCadenceDue(kpi)) {
    return { ok: false, reason: 'cadence_not_due' };
  }

  const links = buildKpiBurstLinks(kpi, registry);
  const { action, reason } = suggestKpiAction(kpi, links);
  if (action === 'achieved') {
    return { ok: false, reason: `kpi_${action}:${reason}` };
  }

  return { ok: true, reason: 'next_burst' };
}

function leafKpisFor(kpi: KpiRecord, kpiRegistry: KpiRegistry): KpiRecord[] {
  if (kpi.isLeaf) return [kpi];
  return (kpi.children ?? [])
    .map((id) => kpiRegistry.get(id))
    .filter((k): k is KpiRecord => k != null && k.isLeaf);
}

/** 任一 active KPI 仍有在途 burst → 心跳应 hold（跳过 legacy LLM 心跳） */
export function isKpiSprintInProgress(
  registry: InnerBrainRegistry,
  kpiRegistry: KpiRegistry,
): boolean {
  for (const kpi of kpiRegistry.list({ status: 'active' })) {
    for (const leaf of leafKpisFor(kpi, kpiRegistry)) {
      const inst = leaf.canonicalInstanceId ?? leaf.bursts[leaf.bursts.length - 1];
      if (!inst) continue;
      const rec = registry.get(inst);
      if (!rec || rec.kpiId !== leaf.kpiId) continue;
      if (rec.status === 'RUNNING') return true;
      if (leaf.kind === 'ongoing') {
        if (!isKpiSlotIdle(leaf, registry)) return true;
      } else if (LIVE_KPI_BURST_STATUSES.has(rec.status)) {
        return true;
      }
    }
  }
  return false;
}
