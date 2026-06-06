/**
 * 战略规划层 — 类型契约（ADL 权威：doc/structurizr/STRATEGY-PLANNING-LAYER.md §5/§7）。
 *
 * strategy = kpiRegistry + EnvironmentSnapshot 的 **typed 投影**，非独立真相源。
 * 唯一写权：strategyPlanner.plan()；dispatcher/reaper/judge 只读。
 */

export type CullReason = 'kpi_paused' | 'kpi_archived' | 'strategy_shift' | 'belief_expired';
export type CullGrace = 'now' | 'warn_in_im_then_kill';

export interface CullDirective {
  burstInstanceId: string;
  reason: CullReason;
  grace: CullGrace;
  note?: string;
}

export interface StaleAwaitingPolicy {
  /** AWAITING 超时硬上限（默认 7d） */
  maxAwaitingMs: number;
  /** 无进展信号触发 reflect 复审（默认 3d） */
  requireProgressSignalAfterMs: number;
}

export type ReEvaluateEvent =
  | 'user_message'
  | 'kpi_blocked'
  | 'burst_replan_limit'
  | 'env_event_threshold';

export interface ReEvaluatePolicy {
  onBurstExits: number;
  onMs: number;
  onEvents: ReEvaluateEvent[];
}

export interface StrategyArtifact {
  version: 1;
  agentId: string;
  updatedAt: string;
  /** 当前承认在推的 KPI；必须是 kpiRegistry.active 的子集 */
  activeKpis: string[];
  /** 优先级；dispatcher 必须按此挑 */
  focusOrder: string[];
  /** 战略软建议 paused（registry 显式 paused/archived 优先） */
  pausedKpis: { id: string; reason: string }[];
  /** WHY — 当前战略假设与取舍 */
  theory: string;
  /** WHY — 为何现在推这些 KPI */
  whyNow: string;
  /** WHY — 上一段 strategy 期间的关键 lesson */
  recentLessons: { burstId: string; takeaway: string }[];
  /** HOW — 对下一 burst 的预期 */
  nextExpectation: string;
  /** REFLECT 显式杀指令（语义层，非超时） */
  cullDirectives: CullDirective[];
  staleAwaitingPolicy: StaleAwaitingPolicy;
  reEvaluateAfter: ReEvaluatePolicy;
}

export const DEFAULT_STALE_AWAITING_POLICY: StaleAwaitingPolicy = {
  maxAwaitingMs: 7 * 24 * 60 * 60 * 1000,
  requireProgressSignalAfterMs: 3 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_REEVALUATE_POLICY: ReEvaluatePolicy = {
  onBurstExits: 1,
  onMs: 6 * 60 * 60 * 1000,
  onEvents: ['user_message', 'kpi_blocked', 'burst_replan_limit', 'env_event_threshold'],
};

/** strategyPlanner 重评估输入摘要（§7 的 P0 子集） */
export interface StrategyPlanInput {
  agentId: string;
  /** active + paused 的 KPI 摘要 */
  kpis: Array<{
    id: string;
    title: string;
    status: 'active' | 'paused' | string;
    kind?: string;
    momentum?: number;
    reflexionDigest?: string;
  }>;
  /** 最近 burst 行为摘要 */
  recentBursts: Array<{
    instanceId: string;
    kpiId?: string;
    state: string;
    durationMs?: number;
    abortReason?: string;
    reflexionSummary?: string;
  }>;
  /** 未消费的显著环境事件（人话 note） */
  envEvents: Array<{ sensorId: string; field: string; note: string }>;
  /** 环境当前要点（人话；由 facade 从 EnvironmentSnapshot 摘出） */
  envDigest?: string;
  lastStrategy: StrategyArtifact | null;
}

/** strategy/journal.jsonl 单行 */
export interface StrategyJournalEntry {
  at: string;
  triggers: string[];
  activeKpisBefore: string[];
  activeKpisAfter: string[];
  focusOrderBefore: string[];
  focusOrderAfter: string[];
  cullDirectivesEmitted: number;
  durationMs: number;
  rejected?: boolean;
  rejectErrors?: string[];
}
