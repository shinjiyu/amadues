/**
 * KPI 推进主循环 — ADL KPI-ADVANCEMENT.md §7
 */
import type { KpiRegistry, KpiRecord } from '../kpi-registry.js';
import type { InnerBrainRegistry } from '../inner-brain-registry.js';
import { executeOuterTool, type OuterToolContext } from '../outer-tools.js';
import { isSetGoalDispatched, buildKpiContinuationGoal } from '../inner-brain-kpi-reuse.js';
import { stopInnerBrainInstance } from '../stop-inner-brain.js';
import { decomposeParentKpiIfNeeded } from './sub-kpi-decomposer.js';
import { evaluateKpiSlotIdle } from './kpi-slot-idle.js';
import { isCadenceDue, refreshKpiNextDueAt } from './kpi-cadence.js';
import { needsPreemptForAdvance } from './burst-reuse.js';
import {
  buildBurstRunRecord,
  formatBurstRunDigest,
  mapRegistryStatusToRunExit,
  readCharterFromWorkDir,
  recordBurstRunOnExit,
} from './burst-run-history.js';

export { recordBurstRunOnExit } from './burst-run-history.js';

export interface KpiAdvancerDeps {
  kpiRegistry: KpiRegistry;
  innerBrainRegistry: InnerBrainRegistry;
  toolCtx: OuterToolContext;
  workspaceId: string;
  defaultThreadId: string;
  focusOrder?: string[];
  strategyMode?: boolean;
  stuckThreshold?: number;
}

export interface KpiAdvanceResult {
  ok: boolean;
  kpiId?: string;
  instanceId?: string;
  reason: string;
  detail?: string;
}

export interface KpiAdvancerTickResult {
  advanced: boolean;
  results: KpiAdvanceResult[];
}

function orderLeafKpis(
  kpiRegistry: KpiRegistry,
  focusOrder?: string[],
  strategyMode?: boolean,
): KpiRecord[] {
  const leaves = kpiRegistry.listLeafKpis({ status: 'active' });
  if (!focusOrder?.length) {
    return leaves.sort((a, b) => b.momentum - a.momentum);
  }
  const ordered: KpiRecord[] = [];
  const seen = new Set<string>();
  for (const id of focusOrder) {
    const k = leaves.find((x) => x.kpiId === id);
    if (k) {
      ordered.push(k);
      seen.add(id);
    }
    const parent = kpiRegistry.get(id);
    if (parent?.children?.length) {
      for (const cid of parent.children) {
        const child = leaves.find((x) => x.kpiId === cid);
        if (child && !seen.has(cid)) {
          ordered.push(child);
          seen.add(cid);
        }
      }
    }
  }
  // 战略模式：focusOrder 与 active 无交集 → 不推进任何 KPI
  if (strategyMode && ordered.length === 0) {
    return [];
  }
  for (const k of leaves) {
    if (!seen.has(k.kpiId)) ordered.push(k);
  }
  return ordered;
}

export function buildKpiSprintGoal(kpi: KpiRecord, _kpiRegistry?: KpiRegistry): string {
  const historyBlock = formatBurstRunDigest(kpi, 5);
  const charter = kpi.charter?.trim() || kpi.description;
  return (
    `# KPI sprint（外脑推进）\n\n` +
    `origin_user: ${kpi.createdBy}\n\n` +
    `## 本轮章程\n${charter}\n\n` +
    `## KPI\n${kpi.description}\n\n` +
    `${historyBlock}\n` +
    `\n## 执行约束\n` +
    `- 本轮 EXECUTE 只完成**一小步**，完成后 REVIEW/REPLAN 并结束（外脑将按节拍再派）\n` +
    `- 沿用本 workspace 已有产出，增量更新\n` +
    `- **不要**调用 wait_timer 长睡；短 retry/限速等待除外\n`
  );
}

function preemptAwaitingBurst(
  deps: KpiAdvancerDeps,
  kpi: KpiRecord,
): void {
  const toPreempt = needsPreemptForAdvance(kpi, deps.innerBrainRegistry);
  if (!toPreempt) return;

  const charter = readCharterFromWorkDir(toPreempt.workDir) || kpi.charter || kpi.description;
  stopInnerBrainInstance(toPreempt, deps.innerBrainRegistry, 'kpi_advancer:preempt_timer_awaiting');

  const updated = deps.innerBrainRegistry.get(toPreempt.instanceId);
  const exitStatus = mapRegistryStatusToRunExit(updated?.status ?? 'STOPPED', true);
  deps.kpiRegistry.appendBurstRun(
    kpi.kpiId,
    buildBurstRunRecord({
      kpiId: kpi.kpiId,
      instanceId: toPreempt.instanceId,
      charter,
      task: { ...toPreempt, status: updated?.status ?? 'STOPPED' },
      exitStatus,
    }),
  );
  deps.innerBrainRegistry.update(toPreempt.instanceId, {
    status: 'DONE',
    finishedAt: new Date().toISOString(),
    pid: undefined,
  });
}

async function dispatchLeafSprint(
  deps: KpiAdvancerDeps,
  kpi: KpiRecord,
): Promise<KpiAdvanceResult> {
  preemptAwaitingBurst(deps, kpi);

  const slot = evaluateKpiSlotIdle(kpi, deps.innerBrainRegistry);
  if (!slot.idle) {
    return { ok: false, kpiId: kpi.kpiId, reason: slot.reason };
  }
  if (!isCadenceDue(kpi)) {
    return { ok: false, kpiId: kpi.kpiId, reason: 'cadence_not_due' };
  }

  const goal =
    kpi.burstRunHistory.length > 0 || kpi.bursts.length > 0
      ? buildKpiSprintGoal(kpi, deps.kpiRegistry)
      : buildKpiContinuationGoal(kpi);

  const toolOut = await executeOuterTool(
    'set_goal',
    JSON.stringify({
      goal,
      workspace_id: deps.workspaceId,
      kpi_id: kpi.kpiId,
      origin_thread: deps.defaultThreadId.trim() || undefined,
    }),
    { ...deps.toolCtx, allowKpiSetGoal: true },
  );

  if (!isSetGoalDispatched(toolOut.output)) {
    return { ok: false, kpiId: kpi.kpiId, reason: 'set_goal_failed', detail: toolOut.output.slice(0, 200) };
  }

  const m = toolOut.output.match(/instance_id=([^\s,，]+)/);
  const instanceId = m?.[1];
  if (instanceId) {
    deps.kpiRegistry.setCanonicalInstance(kpi.kpiId, instanceId);
  }

  const now = new Date().toISOString();
  deps.kpiRegistry.update(kpi.kpiId, {
    lastBurstAt: now,
    nextDueAt: refreshKpiNextDueAt({ ...kpi, lastBurstAt: now }),
    charter: kpi.charter ?? goal.slice(0, 500),
  });

  return {
    ok: true,
    kpiId: kpi.kpiId,
    instanceId,
    reason: 'kpi_sprint_dispatched',
    detail: toolOut.output.slice(0, 200),
  };
}

/** 推进单个 KPI（父节点会先首拆） */
export async function advanceKpi(
  deps: KpiAdvancerDeps,
  kpiId: string,
): Promise<KpiAdvanceResult> {
  const kpi = deps.kpiRegistry.get(kpiId);
  if (!kpi || kpi.status !== 'active') {
    return { ok: false, reason: 'kpi_not_active' };
  }

  if (!kpi.isLeaf) {
    const childIds = decomposeParentKpiIfNeeded(deps.kpiRegistry, kpiId);
    for (const cid of childIds) {
      const child = deps.kpiRegistry.get(cid);
      if (child && isCadenceDue(child) && evaluateKpiSlotIdle(child, deps.innerBrainRegistry).idle) {
        const r = await dispatchLeafSprint(deps, child);
        if (r.ok) return r;
      }
    }
    return { ok: false, reason: 'parent_decomposed_no_dispatch', detail: childIds.join(',') };
  }

  return dispatchLeafSprint(deps, kpi);
}

/** 心跳遍历 leaf KPI，派第一发 due 且 idle 的 sprint */
export async function tickKpiAdvancer(deps: KpiAdvancerDeps): Promise<KpiAdvancerTickResult> {
  const results: KpiAdvanceResult[] = [];
  for (const leaf of orderLeafKpis(deps.kpiRegistry, deps.focusOrder, deps.strategyMode)) {
    const r = await advanceKpi(deps, leaf.kpiId);
    results.push(r);
    if (r.ok && r.reason === 'kpi_sprint_dispatched') {
      return { advanced: true, results };
    }
  }
  return { advanced: false, results };
}
