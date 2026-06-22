/**
 * 集成：KPI 注册表 ↔ registry 行 ↔ kpiCompletionJudge.sweep
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentStackFixture, type AgentStackFixture } from '../testing/index.js';
import { suggestKpiAction, buildKpiBurstLinks } from '../outer/kpi-progress.js';
import { sweepKpiCompletions } from '../outer/kpi-completion-judge.js';

describe('integration: KPI lifecycle', () => {
  let fx: AgentStackFixture;

  afterEach(() => {
    fx?.cleanup();
  });

  it('完成型 burst → sweep achieved + 建议动作一致', () => {
    fx = createAgentStackFixture();
    const kpiId = fx.createKpi('GitLab 贡献者评估');

    fx.simulateBurstExit(kpiId, {
      verdict: 'success',
      deliverables: ['evaluation.md', 'contributor_report.md'],
      postComplete: true,
    });

    expect(fx.kpiRegistry.get(kpiId)?.status).toBe('active');
    const r = sweepKpiCompletions(fx.kpiRegistry, fx.innerBrainRegistry);
    expect(r.marked).toContain(kpiId);
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
    expect(suggestKpiAction(k, buildKpiBurstLinks(k, fx.innerBrainRegistry)).action).toBe(
      'follow_up',
    );
  });
});
