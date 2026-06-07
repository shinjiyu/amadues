/**
 * 集成：KPI 注册表 ↔ 内脑 burst 退出 hook ↔ 自动 achieved
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentStackFixture, type AgentStackFixture } from '../testing/index.js';
import { suggestKpiAction, buildKpiBurstLinks } from '../outer/kpi-progress.js';

describe('integration: KPI lifecycle', () => {
  let fx: AgentStackFixture;

  afterEach(() => {
    fx?.cleanup();
  });

  it('完成型 burst → KPI achieved + 建议动作一致', () => {
    fx = createAgentStackFixture();
    const kpiId = fx.createKpi('GitLab 贡献者评估');

    const { outcome } = fx.simulateBurstExit(kpiId, {
      verdict: 'success',
      deliverables: ['evaluation.md', 'contributor_report.md'],
      postComplete: true,
    });

    expect(outcome.autoAchieved).toBe(true);
    expect(fx.kpiRegistry.get(kpiId)?.status).toBe('achieved');

    const k = fx.kpiRegistry.get(kpiId)!;
    const suggestion = suggestKpiAction(k, buildKpiBurstLinks(k, fx.innerBrainRegistry));
    expect(suggestion.action).toBe('achieved');
  });

  it('阻塞型 burst → 保持 active + follow_up', () => {
    fx = createAgentStackFixture();
    const kpiId = fx.createKpi('邮件发送');

    fx.simulateBurstExit(kpiId, {
      verdict: 'failed',
      asyncWaiting: true,
      deliverables: [],
    });

    const k = fx.kpiRegistry.get(kpiId)!;
    expect(k.status).toBe('active');
    expect(k.consecutiveIdleBursts).toBe(0);
    expect(suggestKpiAction(k, buildKpiBurstLinks(k, fx.innerBrainRegistry)).action).toBe(
      'follow_up',
    );
  });

  it('连续无产出 → idle 累加且 outcome 评估失败', () => {
    fx = createAgentStackFixture();
    const kpiId = fx.createKpi('监督 Shiro');

    let last = fx.simulateBurstExit(kpiId, { verdict: 'failed', deliverables: [] }).outcome;
    last = fx.simulateBurstExit(kpiId, { verdict: 'failed', deliverables: [] }).outcome;
    last = fx.simulateBurstExit(kpiId, { verdict: 'failed', deliverables: [] }).outcome;

    expect(fx.kpiRegistry.get(kpiId)?.consecutiveIdleBursts).toBe(3);
    expect(last.outcomeEvaluation?.successConfirmed).toBe(false);
    expect(last.reflexionBurstId).toBeNull();
    expect(fx.nextBurstsScheduled.length).toBeGreaterThan(0);
  });
});
