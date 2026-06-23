/**
 * KPI 管理器 — 环境感知后的 KPI/burst 编排（ADL KPI-MANAGER-LAYER.md）
 */
import type { KpiRegistry } from '../kpi-registry.js';
import type { InnerBrainRegistry } from '../inner-brain-registry.js';
import type { OuterToolContext } from '../outer-tools.js';
import type {
  AutonomyPolicy,
  AutonomyVerdict,
} from '../autonomy-types.js';
import type { EnvironmentSnapshot } from '../environment/environment-types.js';
import { evaluateKpiSpawnCapacity } from '../environment/kpi-spawn-capacity.js';
import {
  loadAutonomyPolicy,
  markAutonomousAction,
} from '../environment/autonomy-policy-store.js';
import {
  isTaskOnCooldown,
  isTaskOverDailyLimit,
  recordTaskDispatch,
} from '../autonomy-task-state.js';
import {
  reap,
  selectStaleAwaiting,
  type ReaperDeps,
  type ReapOutcome,
} from './stale-burst-reaper.js';
import {
  tickKpiAdvancer,
  type KpiAdvancerTickResult,
  type KpiAdvancerDeps,
} from './kpi-advancer.js';
import { DEFAULT_STALE_AWAITING_POLICY, type StaleAwaitingPolicy } from './kpi-awaiting-policy.js';
import { buildKpiReaperDeps } from './kpi-reaper-live.js';
import { reviewAwaitingBursts, type AwaitingReviewResult } from './kpi-awaiting-review.js';
import type { AwaitingReviewLlmCaller } from './kpi-awaiting-review-llm.js';
import {
  tripFailureCircuitBreakers,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  type FailureCircuitResult,
} from './kpi-failure-circuit.js';

export { DEFAULT_STALE_AWAITING_POLICY, type StaleAwaitingPolicy } from './kpi-awaiting-policy.js';
export { buildKpiReaperDeps } from './kpi-reaper-live.js';
export { reviewAwaitingBursts } from './kpi-awaiting-review.js';

export interface KpiManagerDeps {
  dataRoot: string;
  registry: InnerBrainRegistry;
  kpiRegistry: KpiRegistry;
  toolCtx: OuterToolContext;
  workspaceId: string;
  defaultThreadId: string;
  staleAwaitingPolicy?: StaleAwaitingPolicy;
  reaperDeps?: ReaperDeps;
  advancerTick?: typeof tickKpiAdvancer;
  now?: () => number;
  /** P3：长 AWAITING LLM 复审（注入 caller；缺省仅 deterministic R3/R4） */
  awaitingReviewLlm?: AwaitingReviewLlmCaller;
  /** R7：连续失败熔断阈值（默认 3） */
  maxConsecutiveFailures?: number;
}

export interface KpiManagerTickResult {
  awaitingReview: AwaitingReviewResult;
  reaped: ReapOutcome;
  failureCircuit: FailureCircuitResult;
  advance: KpiAdvancerTickResult | null;
  dispatched: boolean;
  reason: string;
  detail?: string;
  instanceId?: string;
  kpiId?: string;
}

function buildAdvancerDeps(
  deps: KpiManagerDeps,
  environment: EnvironmentSnapshot,
  policy: AutonomyPolicy,
): KpiAdvancerDeps {
  const capacity = evaluateKpiSpawnCapacity(environment, policy);
  return {
    kpiRegistry: deps.kpiRegistry,
    innerBrainRegistry: deps.registry,
    toolCtx: deps.toolCtx,
    workspaceId: deps.workspaceId,
    defaultThreadId: deps.defaultThreadId,
    environment,
    spawnPolicy: policy,
    hasSystemCapacity: capacity.hasInnerSlot,
    allowParallel: true,
    maxParallelPerKpi: policy.hardGates.maxParallelBurstsPerKpi,
    maxConsecutiveFailures: deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
  };
}

function kpiTaskEligible(dataRoot: string, policy: AutonomyPolicy): { ok: boolean; reason: string } {
  const cfg = policy.taskTypes.kpi_inner_goal ?? { enabled: false, cooldownMs: 0, maxPerDay: 0 };
  if (!cfg.enabled) return { ok: false, reason: 'kpi_inner_goal_disabled' };
  if (isTaskOnCooldown(dataRoot, 'kpi_inner_goal', cfg.cooldownMs)) {
    return { ok: false, reason: 'kpi_inner_goal_cooldown' };
  }
  if (isTaskOverDailyLimit(dataRoot, 'kpi_inner_goal', cfg.maxPerDay)) {
    return { ok: false, reason: 'kpi_inner_goal_max_per_day' };
  }
  return { ok: true, reason: 'ok' };
}

/** R5：清理超时 AWAITING burst（每 tick 执行，不受 idle gate 限制） */
export async function reapStaleBursts(deps: KpiManagerDeps): Promise<ReapOutcome> {
  const nowMs = deps.now?.() ?? Date.now();
  const policy = deps.staleAwaitingPolicy ?? DEFAULT_STALE_AWAITING_POLICY;
  const tasks = deps.registry.list();
  const staleHits = selectStaleAwaiting(tasks, policy, nowMs);
  const reaperDeps = deps.reaperDeps ?? buildKpiReaperDeps(deps.registry, deps.dataRoot, () => nowMs);
  return reap([], staleHits, reaperDeps);
}

/**
 * 心跳 KPI 管理器主 tick：
 * 1. reviewAwaitingBursts（R3/R4）
 * 2. reapStaleBursts（R5）
 * 3. verdict=idle 且环境 facets 允许 → tickKpiAdvancer（R1/R2）
 */
export async function tickKpiManager(
  deps: KpiManagerDeps,
  environment: EnvironmentSnapshot,
  verdict: AutonomyVerdict,
): Promise<KpiManagerTickResult> {
  const awaitingReview = await reviewAwaitingBursts(deps, {
    nowMs: deps.now?.(),
    staleAwaitingPolicy: deps.staleAwaitingPolicy ?? DEFAULT_STALE_AWAITING_POLICY,
    callLlm: deps.awaitingReviewLlm,
  });
  const reaped = await reapStaleBursts(deps);

  // R7：连续失败熔断（每 tick 执行，不受 idle gate 限制；先 pause 再续派）
  const failureCircuit = await tripFailureCircuitBreakers({
    dataRoot: deps.dataRoot,
    kpiRegistry: deps.kpiRegistry,
    registry: deps.registry,
    toolCtx: deps.toolCtx,
    defaultThreadId: deps.defaultThreadId,
    maxConsecutiveFailures: deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES,
  });

  if (verdict.level !== 'idle') {
    return {
      awaitingReview,
      reaped,
      failureCircuit,
      advance: null,
      dispatched: false,
      reason: verdict.blockedByHardGate ?? 'busy',
    };
  }

  const policy = loadAutonomyPolicy(deps.dataRoot);
  const hasActiveKpi = deps.kpiRegistry.list({ status: 'active' }).length > 0;
  if (!hasActiveKpi) {
    return { awaitingReview, reaped, failureCircuit, advance: null, dispatched: false, reason: 'no_active_kpi' };
  }

  const spawnCapacity = evaluateKpiSpawnCapacity(environment, policy);
  if (!spawnCapacity.canSpawn) {
    return {
      awaitingReview,
      reaped,
      failureCircuit,
      advance: null,
      dispatched: false,
      reason: spawnCapacity.reason ?? 'spawn_capacity_blocked',
    };
  }

  const elig = kpiTaskEligible(deps.dataRoot, policy);
  if (!elig.ok) {
    return { awaitingReview, reaped, failureCircuit, advance: null, dispatched: false, reason: elig.reason };
  }

  const tickFn = deps.advancerTick ?? tickKpiAdvancer;
  const advance = await tickFn(buildAdvancerDeps(deps, environment, policy));

  if (!advance.advanced) {
    const last = advance.results[advance.results.length - 1];
    return {
      awaitingReview,
      reaped,
      failureCircuit,
      advance,
      dispatched: false,
      reason: last?.reason ?? 'kpi_no_dispatch',
      detail: advance.results.map((r) => `${r.kpiId ?? '-'}:${r.reason}`).join('; ').slice(0, 300),
    };
  }

  const ok = advance.results.find((r) => r.ok);
  recordTaskDispatch(deps.dataRoot, 'kpi_inner_goal');
  markAutonomousAction(deps.dataRoot);

  return {
    awaitingReview,
    reaped,
    failureCircuit,
    advance,
    dispatched: true,
    reason: ok?.reason ?? 'kpi_sprint_dispatched',
    detail: ok?.detail,
    instanceId: ok?.instanceId,
    kpiId: ok?.kpiId,
  };
}
