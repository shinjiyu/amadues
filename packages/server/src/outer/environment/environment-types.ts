/**
 * 环境模型 — 类型契约（ADL 权威：doc/structurizr/ENVIRONMENT-MODEL.md §4-6）。
 *
 * 用「传感器注册表 + 时序日志 + 派生指标」替代扁平、无记忆的 ResourceSnapshot。
 * sensor 只读、禁 LLM、禁阻塞 IO；判定/战略方读 facets[id].data + facets[id].derived，
 * 不直接调 sensor.read。
 */
import type { InnerBrainRegistry } from '../inner-brain-registry.js';

/** sensor 一次读出的 facet 在某时刻的样本 */
export interface FacetSample<T = unknown> {
  at: number;
  data: T;
}

/** 单个 sensor 的历史序列（最近 N 个 tick，由 ring buffer 提供） */
export interface FacetSeries<T = unknown> {
  sensorId: string;
  samples: FacetSample<T>[];
}

/** 显著事件（detectEvents 命中后落 events.jsonl） */
export interface EnvironmentEvent {
  at: string;
  sensorId: string;
  kind: 'threshold_crossed' | 'state_change' | 'first_seen' | 'lost' | 'derivative_spike';
  /** facet 内具体字段（如 'awaiting' / 'tokensRatePerMin'） */
  field: string;
  before?: unknown;
  after?: unknown;
  /** 给 LLM 看的人话 */
  note: string;
  /** 被 strategyPlanner.reflect 消费过的标记，避免重复入 prompt */
  consumedByStrategyAt?: string;
}

/** 小时聚合（hourly.jsonl） */
export interface HourlyAggregate {
  hour: string;
  sensorId: string;
  field: string;
  count: number;
  avg: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

/** sensor 只读依赖注入；sensor 不得直 import 业务模块 */
export interface SensorContext {
  agentId: string;
  /** 本 tick 墙钟（注入便于测试 deterministic） */
  now: number;
  registry: InnerBrainRegistry;
  defaultThreadId: string;
  getOrchestratorStats: () => { queuedTotal: number; activeThreads: number };
  getLlmUsageSnapshot: () => {
    inFlight: number;
    tokensLast1h: { prompt: number; completion: number; total: number };
    callsLast1h: number;
  };
  getParticipationState: (threadId: string) => {
    lastProactiveAt: number;
    proactiveCount5min: number;
  };
  getProcessMemory: () => { heapUsed: number; rss: number };
}

export type SensorCadence = 'every_tick' | 'rate_limited' | 'on_event';

export interface EnvironmentSensor<TFacet = unknown> {
  /** 稳定 id：snapshot.facets[id]、journal 序列 key、判定/策略引用 key */
  id: string;
  label: string;
  /** 给 STRATEGY-REFLECT LLM 看：这条 facet 表示什么、什么时候重要 */
  description: string;
  cadence: SensorCadence;
  cadenceConfig?: { minIntervalMs?: number; events?: string[] };
  /** 同步读取；禁 LLM、禁阻塞 IO */
  read(ctx: SensorContext): TFacet;
  /** 关键字段比较，避免噪声（默认 deep equal） */
  hasChanged?(prev: TFacet, next: TFacet): boolean;
  /** 显著事件检测 */
  detectEvents?(
    prev: TFacet | null,
    next: TFacet,
    history: FacetSeries<TFacet>,
    nowIso: string,
  ): EnvironmentEvent[];
  /** 派生量（rate / streak / delta / zScore），deterministic */
  derive?(history: FacetSeries<TFacet>): Record<string, number>;
}

export interface FacetEnvelope<T = unknown> {
  sensorId: string;
  capturedAt: string;
  data: T;
  derived: Record<string, number>;
  staleness?: 'fresh' | 'cached' | 'stale';
}

export interface EnvironmentSnapshot {
  capturedAt: string;
  agentId: string;
  facets: Record<string, FacetEnvelope>;
}

// ── 内置 sensor facet 形状（与 resourceProbe 对齐，便于 toResourceSnapshot 适配） ──

export interface InnerBrainsFacet {
  running: number;
  awaiting: number;
  blocked: number;
  asyncWaiting: number;
}

export interface LlmUsageFacet {
  inFlight: number;
  tokensLast1h: { prompt: number; completion: number; total: number };
  callsLast1h: number;
}

export interface InboundFacet {
  orchestratorQueuedTotal: number;
  outerLoopActiveThreads: number;
}

export interface ImFacet {
  lastProactiveSpeakAt: string | null;
  proactiveCount5min: number;
}

export interface ProcessFacet {
  heapUsedMb: number;
  rssMb: number;
}

export interface TimeFacet {
  iso: string;
  /** 本地小时 0-23（agent 时区按 UTC 处理，P0 简化） */
  hour: number;
  /** 0=周日 … 6=周六 */
  dayOfWeek: number;
  isQuietHours: boolean;
  dayOfWeekKind: 'weekday' | 'weekend';
}
