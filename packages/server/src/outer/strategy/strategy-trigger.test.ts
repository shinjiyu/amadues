/**
 * strategyTrigger 单测：§6 重评估触发器表。
 * ADL: doc/structurizr/STRATEGY-PLANNING-LAYER.md §6
 */
import { describe, expect, it } from 'vitest';
import { shouldReevaluate, type ReevaluateContext } from './strategy-trigger.js';
import { DEFAULT_REEVALUATE_POLICY } from './strategy-types.js';

function ctx(overrides: Partial<ReevaluateContext> = {}): ReevaluateContext {
  return {
    hasStrategy: true,
    burstExitsSinceLast: 0,
    msSinceLastPlan: 0,
    userMessageSinceLast: false,
    hasUnconsumedThresholdEvent: false,
    needsStrategyReview: false,
    policy: DEFAULT_REEVALUATE_POLICY,
    ...overrides,
  };
}

describe('shouldReevaluate', () => {
  it('无 strategy → 重评估', () => {
    const r = shouldReevaluate(ctx({ hasStrategy: false }));
    expect(r.reevaluate).toBe(true);
    expect(r.triggers).toContain('no_strategy');
  });

  it('稳定态（全无触发）→ 不重评估', () => {
    expect(shouldReevaluate(ctx()).reevaluate).toBe(false);
  });

  it('burst 退出达 onBurstExits → 重评估', () => {
    const r = shouldReevaluate(ctx({ burstExitsSinceLast: 1 }));
    expect(r.triggers).toContain('burst_exit');
  });

  it('onMs 命中 → 重评估', () => {
    const r = shouldReevaluate(ctx({ msSinceLastPlan: DEFAULT_REEVALUATE_POLICY.onMs }));
    expect(r.triggers).toContain('on_ms');
  });

  it('用户消息 → 重评估', () => {
    expect(shouldReevaluate(ctx({ userMessageSinceLast: true })).triggers).toContain('user_message');
  });

  it('未消费 threshold 事件 → 重评估', () => {
    expect(shouldReevaluate(ctx({ hasUnconsumedThresholdEvent: true })).triggers).toContain('env_event_threshold');
  });

  it('needsReview → 重评估', () => {
    expect(shouldReevaluate(ctx({ needsStrategyReview: true })).triggers).toContain('needs_review');
  });

  it('policy.onEvents 不含 user_message 时忽略该触发', () => {
    const r = shouldReevaluate(ctx({ userMessageSinceLast: true, policy: { ...DEFAULT_REEVALUATE_POLICY, onEvents: [] } }));
    expect(r.triggers).not.toContain('user_message');
  });
});
