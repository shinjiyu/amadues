/**
 * KPI 推进 — ADL KPI-MANAGER-LAYER.md（扁平 KPI · 多 burst · 每次新 workspace）
 */
import type { KpiRegistry, KpiRecord } from '../kpi-registry.js';
import type { InnerBrainRegistry } from '../inner-brain-registry.js';
import { executeOuterTool, type OuterToolContext } from '../outer-tools.js';
import { isSetGoalDispatched } from '../inner-brain-kpi-reuse.js';
import {
  formatBurstRunDigest,
} from './burst-run-history.js';
import { evaluateKpiAdvanceEligibility } from './kpi-burst-state.js';
import type { AutonomyPolicy } from '../autonomy-types.js';
import type { EnvironmentSnapshot } from '../environment/environment-types.js';
import { evaluateKpiSpawnCapacity } from '../environment/kpi-spawn-capacity.js';

export { recordBurstRunOnExit } from './burst-run-history.js';

export interface KpiAdvancerDeps {
  kpiRegistry: KpiRegistry;
  innerBrainRegistry: InnerBrainRegistry;
  toolCtx: OuterToolContext;
  workspaceId: string;
  defaultThreadId: string;
  /** 心跳路径：直接读 EnvironmentSnapshot facets（优先于 hasSystemCapacity） */
  environment?: EnvironmentSnapshot;
  spawnPolicy?: AutonomyPolicy;
  /** IM/Ops 等无环境快照时的 fallback */
  hasSystemCapacity?: boolean;
  allowParallel?: boolean;
  maxParallelPerKpi?: number;
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

function orderActiveKpis(kpiRegistry: KpiRegistry): KpiRecord[] {
  return kpiRegistry.list({ status: 'active' }).sort((a, b) => b.momentum - a.momentum);
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
    `- 同 KPI 其它 burst workspace 可通过 peer 只读访问；本 workspace 独立产出\n` +
    `- **不要**调用 wait_timer 长睡；短 retry/限速等待除外\n`
  );
}

function resolveSystemCapacity(deps: KpiAdvancerDeps): boolean {
  if (deps.environment && deps.spawnPolicy) {
    return evaluateKpiSpawnCapacity(deps.environment, deps.spawnPolicy).hasInnerSlot;
  }
  return deps.hasSystemCapacity ?? true;
}

async function dispatchKpiSprint(
  deps: KpiAdvancerDeps,
  kpi: KpiRecord,
): Promise<KpiAdvanceResult> {
  const elig = evaluateKpiAdvanceEligibility(kpi, deps.innerBrainRegistry, {
    allowParallel: deps.allowParallel ?? true,
    hasSystemCapacity: resolveSystemCapacity(deps),
    maxParallelPerKpi: deps.maxParallelPerKpi,
  });
  if (!elig.eligible) {
    return { ok: false, kpiId: kpi.kpiId, reason: elig.reason };
  }

  const goal = buildKpiSprintGoal(kpi, deps.kpiRegistry);

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

  const now = new Date().toISOString();
  deps.kpiRegistry.update(kpi.kpiId, {
    lastBurstAt: now,
    charter: kpi.charter ?? goal.slice(0, 500),
  });

  return {
    ok: true,
    kpiId: kpi.kpiId,
    instanceId,
    reason: elig.mode === 'parallel' ? 'kpi_parallel_sprint' : 'kpi_sprint_dispatched',
    detail: toolOut.output.slice(0, 200),
  };
}

/** 推进单个 active KPI（每次新 burst workspace） */
export async function advanceKpi(
  deps: KpiAdvancerDeps,
  kpiId: string,
): Promise<KpiAdvanceResult> {
  const kpi = deps.kpiRegistry.get(kpiId);
  if (!kpi || kpi.status !== 'active') {
    return { ok: false, reason: 'kpi_not_active' };
  }
  return dispatchKpiSprint(deps, kpi);
}

/** 心跳遍历 active KPI，派第一发 eligible sprint */
export async function tickKpiAdvancer(deps: KpiAdvancerDeps): Promise<KpiAdvancerTickResult> {
  const results: KpiAdvanceResult[] = [];
  for (const kpi of orderActiveKpis(deps.kpiRegistry)) {
    const r = await advanceKpi(deps, kpi.kpiId);
    results.push(r);
    if (r.ok && (r.reason === 'kpi_sprint_dispatched' || r.reason === 'kpi_parallel_sprint')) {
      return { advanced: true, results };
    }
  }
  return { advanced: false, results };
}
