/**
 * KPI spawn 容量 — 从 EnvironmentSnapshot facets 读取（ADL KPI-MANAGER-LAYER.md §1）
 */
import type { AutonomyPolicy } from '../autonomy-types.js';
import type {
  EnvironmentSnapshot,
  InboundFacet,
  InnerBrainsFacet,
  LlmUsageFacet,
} from './environment-types.js';

export interface KpiSpawnCapacity {
  /** 是否可 spawn 新 burst（与 hardGates 对齐，读 facets 不经过 ResourceSnapshot 适配） */
  canSpawn: boolean;
  hasInnerSlot: boolean;
  hasLlmCapacity: boolean;
  reason?: string;
}

function innerBrainsFacet(env: EnvironmentSnapshot): InnerBrainsFacet {
  return (env.facets['innerBrains']?.data as InnerBrainsFacet | undefined) ?? {
    running: 0,
    awaiting: 0,
    blocked: 0,
    asyncWaiting: 0,
  };
}

function llmFacet(env: EnvironmentSnapshot): LlmUsageFacet {
  return (env.facets['llmUsage']?.data as LlmUsageFacet | undefined) ?? {
    inFlight: 0,
    tokensLast1h: { prompt: 0, completion: 0, total: 0 },
    callsLast1h: 0,
  };
}

function inboundFacet(env: EnvironmentSnapshot): InboundFacet {
  return (env.facets['inbound']?.data as InboundFacet | undefined) ?? {
    orchestratorQueuedTotal: 0,
    outerLoopActiveThreads: 0,
  };
}

/** 从环境 facets 评估 KPI burst spawn 容量（R1/R2/R6） */
export function evaluateKpiSpawnCapacity(
  env: EnvironmentSnapshot,
  policy: AutonomyPolicy,
): KpiSpawnCapacity {
  const g = policy.hardGates;
  const inner = innerBrainsFacet(env);
  const llm = llmFacet(env);
  const inbound = inboundFacet(env);

  const hasInnerSlot = inner.running < g.maxRunningInnerBrains;
  const hasLlmCapacity = llm.inFlight < g.maxLlmInFlight;

  if (!hasInnerSlot) {
    return {
      canSpawn: false,
      hasInnerSlot: false,
      hasLlmCapacity,
      reason: `running_inner=${inner.running}>=${g.maxRunningInnerBrains}`,
    };
  }
  if (!hasLlmCapacity) {
    return {
      canSpawn: false,
      hasInnerSlot: true,
      hasLlmCapacity: false,
      reason: `llm_in_flight=${llm.inFlight}>=${g.maxLlmInFlight}`,
    };
  }
  if (g.maxTokensPerHour != null && llm.tokensLast1h.total >= g.maxTokensPerHour) {
    return {
      canSpawn: false,
      hasInnerSlot: true,
      hasLlmCapacity: true,
      reason: `tokens_1h=${llm.tokensLast1h.total}>=${g.maxTokensPerHour}`,
    };
  }
  if (inbound.orchestratorQueuedTotal > g.blockIfOrchestratorQueuedAbove) {
    return {
      canSpawn: false,
      hasInnerSlot: true,
      hasLlmCapacity: true,
      reason: `orchestrator_queued=${inbound.orchestratorQueuedTotal}>${g.blockIfOrchestratorQueuedAbove}`,
    };
  }
  if (g.blockIfOuterLoopActive && inbound.outerLoopActiveThreads > 0) {
    return {
      canSpawn: false,
      hasInnerSlot: true,
      hasLlmCapacity: true,
      reason: `outer_loop_active=${inbound.outerLoopActiveThreads}`,
    };
  }

  return { canSpawn: true, hasInnerSlot: true, hasLlmCapacity: true };
}
