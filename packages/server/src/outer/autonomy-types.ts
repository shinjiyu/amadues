export type WorkloadLevel = 'idle' | 'busy';

export interface ResourceSnapshot {
  capturedAt: string;
  agentId: string;
  innerBrains: {
    running: number;
    awaiting: number;
    blocked: number;
    asyncWaiting: number;
  };
  llm: {
    inFlight: number;
    tokensLast1h: { prompt: number; completion: number; total: number };
    callsLast1h: number;
  };
  inbound: {
    orchestratorQueuedTotal: number;
    outerLoopActiveThreads: number;
  };
  im: {
    lastProactiveSpeakAt: string | null;
    proactiveCount5min: number;
  };
  process: {
    heapUsedMb: number;
    rssMb: number;
  };
}

export interface AutonomyHardGates {
  maxRunningInnerBrains: number;
  maxAwaitingInnerBrains: number;
  /** 同 KPI 最多并行 RUNNING/BLOCKED burst（R2 上限） */
  maxParallelBurstsPerKpi: number;
  maxLlmInFlight: number;
  maxTokensPerHour: number | null;
  blockIfOrchestratorQueuedAbove: number;
  /** 兼容 advance 路径（evaluateKpiSpawnCapacity）用；数字员工主路径用 foregroundReserveSlots */
  blockIfOuterLoopActive: boolean;
  /** 前台活跃时为对话预留的内脑槽数（自适应：前台安静时不预留） */
  foregroundReserveSlots?: number;
}

/**
 * DE-4：cooldown/maxPerDay 仅适用于 IM 输出类任务（casual_chat 防刷屏）。
 * KPI 找活（kpi_inner_goal）只有 enabled 开关，不存在时间配额概念。
 */
export interface AutonomyTaskTypeConfig {
  enabled: boolean;
  cooldownMs?: number;
  maxPerDay?: number;
}

export interface AutonomyPolicy {
  version: 1;
  enabled: boolean;
  hardGates: AutonomyHardGates;
  taskTypes: Record<string, AutonomyTaskTypeConfig>;
  lastAutonomousActionAt: string | null;
  updatedAt: string;
  updatedBy: 'chat' | 'env' | 'system' | 'default';
}

export interface AgentPersonality {
  version: 1;
  idleChatProbability: number;
  updatedAt: string;
  updatedBy: 'chat' | 'env' | 'system' | 'default';
}

export interface AutonomyVerdict {
  level: WorkloadLevel;
  reasons: string[];
  blockedByHardGate?: string;
  judgedAt: string;
}

export type AutonomyTaskType = 'casual_chat' | 'kpi_inner_goal';

export interface AutonomyDispatchResult {
  dispatched: boolean;
  taskType?: AutonomyTaskType;
  reason: string;
  detail?: string;
}
