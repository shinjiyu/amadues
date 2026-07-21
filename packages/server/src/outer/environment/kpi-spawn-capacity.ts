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

export interface AvailableCapacity {
  available: boolean;
  freeInnerSlots: number;
  freeLlmSlots: number;
  /** 前台活跃时为对话预留的槽数（DIGITAL-EMPLOYEE-AUTONOMY.md §6.4） */
  foregroundReservedSlots: number;
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

/**
 * Shared digital-employee capacity definition.
 * AWAITING/blocked counts are intentionally ignored: only actual RUNNING work
 * consumes an inner-brain execution slot.
 *
 * 前台对话不再触发全停（旧 blockIfOuterLoopActive 语义仅留给兼容 advance 路径）：
 * 前台活跃时扣除自适应预留槽，扣完才休眠；高压入站仍全面暂停。
 */
export function hasAvailableCapacity(
  env: EnvironmentSnapshot,
  policy: AutonomyPolicy,
): AvailableCapacity {
  const g = policy.hardGates;
  const inner = innerBrainsFacet(env);
  const llm = llmFacet(env);
  const inbound = inboundFacet(env);

  const foregroundActive =
    inbound.outerLoopActiveThreads > 0 || inbound.orchestratorQueuedTotal > 0;
  const foregroundReservedSlots = foregroundActive
    ? Math.max(0, g.foregroundReserveSlots ?? 1)
    : 0;

  const rawFreeInnerSlots = Math.max(0, g.maxRunningInnerBrains - inner.running);
  const freeInnerSlots = Math.max(0, rawFreeInnerSlots - foregroundReservedSlots);
  const freeLlmSlots = Math.max(0, g.maxLlmInFlight - llm.inFlight);

  const base = { freeInnerSlots, freeLlmSlots, foregroundReservedSlots };

  if (!policy.enabled) {
    return { available: false, ...base, reason: 'autonomy_disabled' };
  }
  if (process.env['UTLRA_AUTONOMY_ENABLED'] === '0') {
    return { available: false, ...base, reason: 'env_autonomy_disabled' };
  }
  if (freeLlmSlots <= 0) {
    return {
      available: false,
      ...base,
      reason: `llm_in_flight=${llm.inFlight}>=${g.maxLlmInFlight}`,
    };
  }
  if (g.maxTokensPerHour != null && llm.tokensLast1h.total >= g.maxTokensPerHour) {
    return {
      available: false,
      ...base,
      reason: `tokens_1h=${llm.tokensLast1h.total}>=${g.maxTokensPerHour}`,
    };
  }
  if (inbound.orchestratorQueuedTotal > g.blockIfOrchestratorQueuedAbove) {
    return { available: false, ...base, reason: 'inbound_pressure' };
  }
  if (freeInnerSlots <= 0) {
    return {
      available: false,
      ...base,
      reason: rawFreeInnerSlots > 0 ? 'foreground_reserved' : 'no_inner_slot',
    };
  }

  return { available: true, ...base };
}
