/**
 * 战略规划层 — facade（ADL STRATEGY-PLANNING-LAYER.md §4）。
 *
 * runStrategyPhase 编排单 tick 的 STRATEGY 阶段（store → trigger → plan → store → reaper → dispatch select）。
 * 由 autonomyPipeline 在 verdict=idle 时调用，接管 dispatch（dispatcher 改读 focusOrder）。
 *
 * 阶段顺序硬约束：reaper 必须在 dispatch select 之前（释放的 slot 同 tick 可复用）。
 */
import { StrategyStore } from './strategy-store.js';
import { shouldReevaluate, type ReevaluateContext } from './strategy-trigger.js';
import { planNext, type StrategyLlmCaller } from './strategy-planner.js';
import { selectStrategyDispatch, type StrategyDispatchSelection } from './dispatch-by-strategy.js';
import {
  reap,
  selectNeedsReview,
  selectStaleAwaiting,
  type ReaperDeps,
} from './stale-burst-reaper.js';
import {
  DEFAULT_REEVALUATE_POLICY,
  DEFAULT_STALE_AWAITING_POLICY,
  type StrategyArtifact,
  type StrategyPlanInput,
} from './strategy-types.js';
import type { TaskRecord } from '../inner-brain-registry.js';

export * from './strategy-types.js';
export { StrategyStore } from './strategy-store.js';
export { shouldReevaluate } from './strategy-trigger.js';
export { validateStrategyArtifact } from './strategy-artifact.js';
export { selectStrategyDispatch } from './dispatch-by-strategy.js';
export {
  planNext,
  extractJsonObject,
  buildFallbackArtifact,
  type StrategyLlmCaller,
} from './strategy-planner.js';
export {
  reap,
  selectStaleAwaiting,
  selectNeedsReview,
  type ReaperDeps,
} from './stale-burst-reaper.js';

export interface RunStrategyPhaseDeps {
  dataRoot: string;
  agentId: string;
  /** active + paused KPI 摘要（facade 调用方从 kpiRegistry 摘） */
  planInputKpis: StrategyPlanInput['kpis'];
  recentBursts: StrategyPlanInput['recentBursts'];
  envEvents: StrategyPlanInput['envEvents'];
  envDigest?: string;
  /** registry 所有任务（reaper 用） */
  tasks: TaskRecord[];
  /** 触发器上下文（除 hasStrategy/policy 由本函数补） */
  triggerCtx: Omit<ReevaluateContext, 'hasStrategy' | 'policy'>;
  /** dispatch select 上下文 */
  activeKpiIds: Set<string>;
  canSpawn: boolean;
  onCooldown: (kpiId: string) => boolean;
  /** LLM caller（注入；缺省则只走 cache + reaper，不重规划） */
  callLlm?: StrategyLlmCaller;
  /** reaper 副作用依赖（注入） */
  reaperDeps: ReaperDeps;
  now?: () => number;
}

export interface RunStrategyPhaseResult {
  strategy: StrategyArtifact | null;
  reevaluated: boolean;
  triggers: string[];
  planRejected: boolean;
  planRejectErrors: string[];
  abortedIds: string[];
  dispatch: StrategyDispatchSelection;
}

/**
 * 单 tick STRATEGY 阶段编排。verdict=busy 时调用方应跳过本函数。
 */
export async function runStrategyPhase(deps: RunStrategyPhaseDeps): Promise<RunStrategyPhaseResult> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const store = new StrategyStore(deps.dataRoot);
  let strategy = store.loadCurrent();

  const policy = strategy?.reEvaluateAfter ?? DEFAULT_REEVALUATE_POLICY;
  const decision = shouldReevaluate({
    ...deps.triggerCtx,
    hasStrategy: strategy !== null,
    policy,
  });

  let planRejected = false;
  let planRejectErrors: string[] = [];
  if (decision.reevaluate && deps.callLlm) {
    const before = strategy;
    const input: StrategyPlanInput = {
      agentId: deps.agentId,
      kpis: deps.planInputKpis,
      recentBursts: deps.recentBursts,
      envEvents: deps.envEvents,
      ...(deps.envDigest ? { envDigest: deps.envDigest } : {}),
      lastStrategy: strategy,
    };
    const t0 = nowMs;
    const res = await planNext(input, { callLlm: deps.callLlm, now: () => nowMs });
    planRejected = res.rejected;
    planRejectErrors = res.rejectErrors;
    strategy = res.artifact;
    store.writeCurrent(strategy);
    store.appendJournal({
      at: new Date(nowMs).toISOString(),
      triggers: decision.triggers,
      activeKpisBefore: before?.activeKpis ?? [],
      activeKpisAfter: strategy.activeKpis,
      focusOrderBefore: before?.focusOrder ?? [],
      focusOrderAfter: strategy.focusOrder,
      cullDirectivesEmitted: strategy.cullDirectives.length,
      durationMs: (deps.now ? deps.now() : Date.now()) - t0,
      rejected: res.rejected,
      ...(res.rejected ? { rejectErrors: res.rejectErrors } : {}),
    });
  }

  // REAP（必须在 dispatch 之前）
  const sap = strategy?.staleAwaitingPolicy ?? DEFAULT_STALE_AWAITING_POLICY;
  const staleHits = selectStaleAwaiting(deps.tasks, sap, nowMs);
  const { abortedIds } = await reap(strategy?.cullDirectives ?? [], staleHits, deps.reaperDeps);
  // needsReview 供下一 tick 触发（调用方持久化/置位）；此处仅计算返回
  void selectNeedsReview(deps.tasks, sap, nowMs);

  // DISPATCH select（reaper 已释放 slot；活跃集与 canSpawn 由调用方刷新后传入更佳，此处用入参）
  const dispatch = selectStrategyDispatch(strategy, {
    activeKpiIds: deps.activeKpiIds,
    canSpawn: deps.canSpawn,
    onCooldown: deps.onCooldown,
  });

  return {
    strategy,
    reevaluated: decision.reevaluate && Boolean(deps.callLlm),
    triggers: decision.triggers,
    planRejected,
    planRejectErrors,
    abortedIds,
    dispatch,
  };
}
