/**
 * 战略规划层 — live 接线适配器（ADL STRATEGY-PLANNING-LAYER.md §4/§9/§13）。
 *
 * 把 runStrategyPhase 的注入点接到真实运行时：kpiRegistry / innerBrainRegistry / 真 LLM / process.kill / action-log。
 * 由 autonomyPipeline 在 verdict=idle 时调用。
 *
 * 纯函数辅助（countBurstExitsSince / buildRecentBursts / buildPlanInputKpis / mapEnvEventsForPlan）独立可测。
 */
import { llmRawChatCompletion } from '../../llm/raw.js';
import type { InnerLlmEnv } from '../../llm/inner-llm-step.js';
import type { KpiRecord, KpiRegistry } from '../kpi-registry.js';
import type { InnerBrainRegistry, TaskRecord } from '../inner-brain-registry.js';
import type { ResourceSnapshot } from '../autonomy-types.js';
import { appendAutonomyActionLog } from '../autonomy-action-log.js';
import { StrategyStore } from './strategy-store.js';
import { runStrategyPhase, type RunStrategyPhaseResult } from './index.js';
import { selectNeedsReview, type ReaperDeps } from './stale-burst-reaper.js';
import {
  DEFAULT_STALE_AWAITING_POLICY,
  type StrategyLlmCaller,
  type StrategyPlanInput,
} from './index.js';

/** burst 退出（DONE/ERROR/STOPPED/ABORTED）且发生在 sinceMs 之后的数量 */
export function countBurstExitsSince(tasks: TaskRecord[], sinceMs: number): number {
  let n = 0;
  for (const t of tasks) {
    if (t.status === 'DONE' || t.status === 'ERROR' || t.status === 'STOPPED' || t.status === 'ABORTED') {
      const endIso = t.abortedAt ?? t.finishedAt;
      const end = endIso ? Date.parse(endIso) : NaN;
      if (Number.isFinite(end) ? end > sinceMs : sinceMs === -Infinity) n += 1;
    }
  }
  return n;
}

/** 最近 burst 行为摘要（按 startedAt 倒序的前 limit 条） */
export function buildRecentBursts(tasks: TaskRecord[], limit = 12): StrategyPlanInput['recentBursts'] {
  return tasks.slice(0, limit).map((t) => ({
    instanceId: t.instanceId,
    ...(t.kpiId ? { kpiId: t.kpiId } : {}),
    state: t.status,
    ...(t.abortReason ? { abortReason: t.abortReason } : {}),
  }));
}

/** active + paused KPI → plan 输入摘要 */
export function buildPlanInputKpis(kpis: KpiRecord[]): StrategyPlanInput['kpis'] {
  return kpis.map((k) => ({
    id: k.kpiId,
    title: k.description.slice(0, 120),
    status: k.status,
    kind: k.kind,
    momentum: k.momentum,
    ...(() => {
      const ev = k.burstRunHistory[k.burstRunHistory.length - 1]?.outcomeEvaluation;
      if (!ev) return {};
      const label = ev.successConfirmed ? 'ok' : 'fail';
      return {
        reflexionDigest: `${label}: ${ev.evidenceSummary}`.slice(0, 120),
      };
    })(),
  }));
}

export interface EnvEventLike {
  sensorId: string;
  field: string;
  note: string;
  kind?: string;
}

export function mapEnvEventsForPlan(events: EnvEventLike[]): StrategyPlanInput['envEvents'] {
  return events.map((e) => ({ sensorId: e.sensorId, field: e.field, note: e.note }));
}

/** 把 InnerLlmEnv 包成 strategyPlanner 的 callLlm（真 LLM）。无 env → undefined（只 reap，不重规划） */
export function buildStrategyLlmCaller(env: InnerLlmEnv | null): StrategyLlmCaller | undefined {
  if (!env) return undefined;
  return async ({ system, user }) => {
    const { raw } = await llmRawChatCompletion<{
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    }>({
      provider: env.provider,
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      usageMeta: { source: 'autonomy', model: env.textModel, provider: env.provider },
      body: {
        model: env.textModel,
        temperature: 0.3,
        // GLM-5.1-FP8 在 1400 上限时常 finish_reason=length 且 content 为空（token 耗在 reasoning 通道）→ parse_failed
        max_tokens: Math.min(env.maxTokensText, 8192),
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
    });
    return raw.choices?.[0]?.message?.content?.trim() ?? '';
  };
}

/** 真实 reaper 依赖：registry 迁移 ABORTED + process.kill + action-log */
export function buildReaperDeps(
  registry: InnerBrainRegistry,
  dataRoot: string,
  now: () => number = Date.now,
): ReaperDeps {
  return {
    getTask: (id) => registry.get(id),
    killProcess: (pid) => {
      if (typeof pid === 'number' && pid > 0) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* 进程可能已退出 */
        }
      }
    },
    abort: (id, patch) => {
      registry.update(id, {
        status: 'ABORTED',
        abortReason: patch.abortReason,
        abortedBy: patch.abortedBy,
        abortedAt: patch.abortedAt,
      });
    },
    appendActionLog: (e) => {
      appendAutonomyActionLog(dataRoot, {
        at: e.at,
        dispatched: false,
        reason: `cull_burst:${e.reason}`,
        detail: `${e.reaper}:${e.burstId}`,
      });
    },
    now,
  };
}

export interface LiveStrategyDeps {
  dataRoot: string;
  agentId: string;
  kpiRegistry: KpiRegistry;
  registry: InnerBrainRegistry;
  envEvents: EnvEventLike[];
  envDigest?: string;
  snapshot: ResourceSnapshot;
  maxRunningInnerBrains: number;
  onCooldown?: (kpiId: string) => boolean;
  getLlmEnv: () => InnerLlmEnv | null;
  now?: () => number;
}

/**
 * 跑一轮 live 战略阶段（plan + 持久化 + reap + dispatch select）。
 * 触发器上下文从 strategyStore.lastStrategy + registry 推导（deterministic）。
 */
export async function runLiveStrategyPhase(deps: LiveStrategyDeps): Promise<RunStrategyPhaseResult> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const tasks = deps.registry.list();
  const activeKpis = deps.kpiRegistry.list({ status: 'active' });
  const pausedKpis = deps.kpiRegistry.list({ status: 'paused' });

  const last = new StrategyStore(deps.dataRoot).loadCurrent();
  const lastPlanMs = last ? Date.parse(last.updatedAt) : Number.NaN;
  const sap = last?.staleAwaitingPolicy ?? DEFAULT_STALE_AWAITING_POLICY;

  const triggerCtx = {
    burstExitsSinceLast: countBurstExitsSince(tasks, Number.isFinite(lastPlanMs) ? lastPlanMs : -Infinity),
    msSinceLastPlan: Number.isFinite(lastPlanMs) ? nowMs - lastPlanMs : Number.POSITIVE_INFINITY,
    userMessageSinceLast: false,
    hasUnconsumedThresholdEvent: deps.envEvents.some((e) => e.kind === 'threshold_crossed'),
    needsStrategyReview: selectNeedsReview(tasks, sap, nowMs).length > 0,
  };

  return runStrategyPhase({
    dataRoot: deps.dataRoot,
    agentId: deps.agentId,
    planInputKpis: buildPlanInputKpis([...activeKpis, ...pausedKpis]),
    recentBursts: buildRecentBursts(tasks),
    envEvents: mapEnvEventsForPlan(deps.envEvents),
    ...(deps.envDigest ? { envDigest: deps.envDigest } : {}),
    tasks,
    triggerCtx,
    activeKpiIds: new Set(activeKpis.map((k) => k.kpiId)),
    canSpawn: deps.snapshot.innerBrains.running < deps.maxRunningInnerBrains,
    onCooldown: deps.onCooldown ?? (() => false),
    ...(buildStrategyLlmCaller(deps.getLlmEnv()) ? { callLlm: buildStrategyLlmCaller(deps.getLlmEnv())! } : {}),
    reaperDeps: buildReaperDeps(deps.registry, deps.dataRoot, () => nowMs),
    now: () => nowMs,
  });
}
