/**
 * 环境模型 — facade（ADL ENVIRONMENT-MODEL.md §2 "P0→P1 过渡 facade，不双源真相"）。
 *
 * 对外暴露：
 *   - collectEnvironmentSnapshot：一次 tick 采集（含 journal 留存 + 派生 + 事件）
 *   - toResourceSnapshot：把 EnvironmentSnapshot 适配回旧 ResourceSnapshot，
 *     让现有 autonomyJudge / casualChatDispatcher 零行为差地继续工作。
 */
import type { InnerBrainRegistry } from '../inner-brain-registry.js';
import { getGroupParticipationState } from '../participation-state.js';
import { getLlmUsageSnapshot } from '../llm-usage-tracker.js';
import type { ResourceSnapshot } from '../autonomy-types.js';
import { EnvironmentSensorRegistry } from './sensor-registry.js';
import { EnvironmentJournal } from './journal.js';
import type {
  EnvironmentEvent,
  EnvironmentSnapshot,
  ImFacet,
  InboundFacet,
  InnerBrainsFacet,
  LlmUsageFacet,
  ProcessFacet,
  SensorContext,
} from './environment-types.js';

export * from './environment-types.js';
export { EnvironmentSensorRegistry } from './sensor-registry.js';
export { EnvironmentJournal, aggregateHour } from './journal.js';
export { BUILTIN_SENSORS } from './environment-sensors.js';
export { evaluateAutonomyVerdict, evaluateHardGates } from './autonomy-judge.js';
export {
  defaultAutonomyPolicy,
  loadAutonomyPolicy,
  saveAutonomyPolicy,
  patchAutonomyPolicy,
  markAutonomousAction,
  normalizeDigitalEmployeePolicy,
} from './autonomy-policy-store.js';
export {
  evaluateKpiSpawnCapacity,
  hasAvailableCapacity,
  type AvailableCapacity,
  type KpiSpawnCapacity,
} from './kpi-spawn-capacity.js';

/** 按 dataRoot 缓存的共享环境实例（registry + journal 跨 tick 复用 ring buffer） */
const sharedByRoot = new Map<string, { registry: EnvironmentSensorRegistry; journal: EnvironmentJournal }>();

export function getSharedEnvironment(dataRoot: string): {
  registry: EnvironmentSensorRegistry;
  journal: EnvironmentJournal;
} {
  let shared = sharedByRoot.get(dataRoot);
  if (!shared) {
    shared = { registry: new EnvironmentSensorRegistry(), journal: new EnvironmentJournal(dataRoot) };
    sharedByRoot.set(dataRoot, shared);
  }
  return shared;
}

/** 测试用：清空共享缓存 */
export function resetSharedEnvironmentForTests(): void {
  sharedByRoot.clear();
}

export interface CollectEnvironmentDeps {
  agentId: string;
  registry: InnerBrainRegistry;
  defaultThreadId: string;
  getOrchestratorStats?: () => { queuedTotal: number; activeThreads: number };
  /** 注入墙钟便于测试；默认 Date.now() */
  now?: number;
}

/** 由 deps 构造 SensorContext（注入只读依赖） */
export function buildSensorContext(deps: CollectEnvironmentDeps): SensorContext {
  return {
    agentId: deps.agentId,
    now: deps.now ?? Date.now(),
    registry: deps.registry,
    defaultThreadId: deps.defaultThreadId,
    getOrchestratorStats: deps.getOrchestratorStats ?? (() => ({ queuedTotal: 0, activeThreads: 0 })),
    getLlmUsageSnapshot: () => getLlmUsageSnapshot(),
    getParticipationState: (threadId) => {
      const st = getGroupParticipationState(threadId);
      return { lastProactiveAt: st.lastProactiveAt, proactiveCount5min: st.proactiveCount5min };
    },
    getProcessMemory: () => {
      const m = process.memoryUsage();
      return { heapUsed: m.heapUsed, rss: m.rss };
    },
  };
}

/**
 * 一次 tick 采集环境快照。给 journal 则留存 + 算派生量 + 落事件。
 */
export function collectEnvironmentSnapshot(
  deps: CollectEnvironmentDeps,
  registry: EnvironmentSensorRegistry,
  journal?: EnvironmentJournal,
): { snapshot: EnvironmentSnapshot; events: EnvironmentEvent[] } {
  return registry.collect(buildSensorContext(deps), journal);
}

/**
 * 适配器：EnvironmentSnapshot → 旧 ResourceSnapshot（字段数值一致）。
 * 内置 sensor 缺失时回退为安全零值，保证 autonomyJudge 不崩。
 */
export function toResourceSnapshot(env: EnvironmentSnapshot): ResourceSnapshot {
  const inner = (env.facets['innerBrains']?.data as InnerBrainsFacet | undefined) ?? {
    running: 0,
    awaiting: 0,
    blocked: 0,
    asyncWaiting: 0,
  };
  const llm = (env.facets['llmUsage']?.data as LlmUsageFacet | undefined) ?? {
    inFlight: 0,
    tokensLast1h: { prompt: 0, completion: 0, total: 0 },
    callsLast1h: 0,
  };
  const inbound = (env.facets['inbound']?.data as InboundFacet | undefined) ?? {
    orchestratorQueuedTotal: 0,
    outerLoopActiveThreads: 0,
  };
  const im = (env.facets['im']?.data as ImFacet | undefined) ?? {
    lastProactiveSpeakAt: null,
    proactiveCount5min: 0,
  };
  const proc = (env.facets['process']?.data as ProcessFacet | undefined) ?? {
    heapUsedMb: 0,
    rssMb: 0,
  };
  return {
    capturedAt: env.capturedAt,
    agentId: env.agentId,
    innerBrains: inner,
    llm,
    inbound,
    im,
    process: proc,
  };
}
