/**
 * 战略规划层 — 重评估触发器（ADL STRATEGY-PLANNING-LAYER.md §6）。
 *
 * 把「每心跳重新规划」压成「事件驱动重规划 + 默认沿用 cache」。
 * 纯函数：deterministic，便于单测断言触发器表。
 */
import type { ReEvaluatePolicy } from './strategy-types.js';

export interface ReevaluateContext {
  /** 是否已有 current.json（无 → 必须完整规划） */
  hasStrategy: boolean;
  /** 自上次 plan 以来完成（DONE/BLOCK/REPLAN_LIMIT）的 burst 数 */
  burstExitsSinceLast: number;
  /** 距上次 plan 的毫秒数（无上次 → Infinity） */
  msSinceLastPlan: number;
  /** 自上次 plan 以来用户是否给了新 IM 指令 */
  userMessageSinceLast: boolean;
  /** 是否存在未消费且 kind=threshold_crossed 的环境事件 */
  hasUnconsumedThresholdEvent: boolean;
  /** reaper 置位：某 AWAITING 超 requireProgressSignalAfterMs，需强制复审 */
  needsStrategyReview: boolean;
  /** 上一份战略的重评估策略（无则用默认） */
  policy: ReEvaluatePolicy;
}

export interface ReevaluateDecision {
  reevaluate: boolean;
  triggers: string[];
}

export function shouldReevaluate(ctx: ReevaluateContext): ReevaluateDecision {
  const triggers: string[] = [];

  if (!ctx.hasStrategy) triggers.push('no_strategy');
  if (ctx.burstExitsSinceLast >= Math.max(1, ctx.policy.onBurstExits)) {
    triggers.push('burst_exit');
  }
  if (ctx.msSinceLastPlan >= ctx.policy.onMs) triggers.push('on_ms');
  if (ctx.userMessageSinceLast && ctx.policy.onEvents.includes('user_message')) {
    triggers.push('user_message');
  }
  if (ctx.hasUnconsumedThresholdEvent && ctx.policy.onEvents.includes('env_event_threshold')) {
    triggers.push('env_event_threshold');
  }
  if (ctx.needsStrategyReview) triggers.push('needs_review');

  return { reevaluate: triggers.length > 0, triggers };
}
