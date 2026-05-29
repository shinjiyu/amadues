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
  maxLlmInFlight: number;
  maxTokensPerHour: number | null;
  minMsSinceLastAutonomousAction: number;
  blockIfOrchestratorQueuedAbove: number;
  blockIfOuterLoopActive: boolean;
}

export interface AutonomyTaskTypeConfig {
  enabled: boolean;
  cooldownMs: number;
  maxPerDay: number;
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
