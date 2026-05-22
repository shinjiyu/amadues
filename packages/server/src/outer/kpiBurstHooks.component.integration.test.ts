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

  it('连续 failed → 调度 reflexion burst', () => {
    fx = createAgentStackFixture();
    const kpiId = fx.createKpi('反思型');
    fx.simulateBurstExit(kpiId, { verdict: 'failed' });
    fx.simulateBurstExit(kpiId, { verdict: 'failed' });
    const last = fx.simulateBurstExit(kpiId, { verdict: 'failed' });
    expect(last.outcome.reflexionBurstId).toMatch(/^ib-reflexion-/);
    expect(fx.reflexionBurstsScheduled).toContain(kpiId);
  });
});
