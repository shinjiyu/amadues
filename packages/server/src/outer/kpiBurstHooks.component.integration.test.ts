/**
 * ADL component: kpiBurstHooks — burst 退出 → KPI 状态 / reflexion 调度
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentStackFixture, type AgentStackFixture } from '../testing/index.js';

describe('component: kpiBurstHooks', () => {
  let fx: AgentStackFixture;

  afterEach(() => {
    fx?.cleanup();
  });

  it('success + postComplete → autoAchieved', () => {
    fx = createAgentStackFixture();
    const kpiId = fx.createKpi('达成型');
    const { outcome } = fx.simulateBurstExit(kpiId, {
      verdict: 'success',
      deliverables: ['out.md'],
      postComplete: true,
    });
    expect(outcome.autoAchieved).toBe(true);
    expect(fx.kpiRegistry.get(kpiId)?.status).toBe('achieved');
  });

  it('无产出 → outcome 评估失败并调度续跑', () => {
    fx = createAgentStackFixture();
    const kpiId = fx.createKpi('重试型');
    const { outcome } = fx.simulateBurstExit(kpiId, { verdict: 'failed', deliverables: [] });
    expect(outcome.outcomeEvaluation?.successConfirmed).toBe(false);
    expect(outcome.reflexionBurstId).toBeNull();
    expect(outcome.nextKpiBurstId).toMatch(/^ib-next-/);
    expect(fx.nextBurstsScheduled).toContain(kpiId);
  });
});
