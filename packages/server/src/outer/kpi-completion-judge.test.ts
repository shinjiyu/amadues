import { afterEach, describe, expect, it } from 'vitest';
import { createKpiScenarioFixture, type KpiScenarioFixture } from './kpi-scenario.harness.js';
import { formatKpiCompletionBlock, sweepKpiCompletions } from './kpi-completion-judge.js';

describe('kpiCompletionJudge', () => {
  let fx: KpiScenarioFixture;

  afterEach(() => {
    fx?.cleanup();
  });

  it('DONE + post_complete + 产出 → sweep markAchieved', () => {
    fx = createKpiScenarioFixture('GitLab 评估');
    fx.simulateBurstExit({
      verdict: 'success',
      deliverables: ['report.md'],
      postComplete: true,
    });
    // onExit 不再 autoAchieve；sweep 负责结案
    const r = sweepKpiCompletions(fx.kpiRegistry, fx.innerBrainRegistry);
    expect(r.marked).toContain(fx.kpiId);
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('achieved');
  });

  it('无关联 burst 的 active KPI → sweep 不 mark', () => {
    fx = createKpiScenarioFixture('未派发');
    const r = sweepKpiCompletions(fx.kpiRegistry, fx.innerBrainRegistry);
    expect(r.marked).toHaveLength(0);
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('active');
  });

  it('监督类未 post_complete → sweep 不 mark', () => {
    fx = createKpiScenarioFixture('持续监督');
    fx.simulateBurstExit({
      verdict: 'partial',
      deliverables: ['note.md'],
      postComplete: false,
      asyncWaiting: true,
    });
    const r = sweepKpiCompletions(fx.kpiRegistry, fx.innerBrainRegistry);
    expect(r.marked).toHaveLength(0);
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('active');
  });

  it('formatKpiCompletionBlock 含建议动作', () => {
    fx = createKpiScenarioFixture('测试 KPI');
    const block = formatKpiCompletionBlock(fx.kpiRegistry, fx.innerBrainRegistry);
    expect(block).toContain('KPI 完成态');
    expect(block).toContain(fx.kpiId);
  });

  it('ongoing KPI：即使 DONE+产出 也不被 sweep 结案（永远 active）', () => {
    fx = createKpiScenarioFixture('24h 情报常驻', 'ongoing');
    fx.simulateBurstExit({
      verdict: 'success',
      deliverables: ['report.md'],
      postComplete: true,
    });
    // onExit 不 auto-achieve ongoing
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('active');
    // sweep 也跳过 ongoing
    const r = sweepKpiCompletions(fx.kpiRegistry, fx.innerBrainRegistry);
    expect(r.marked).not.toContain(fx.kpiId);
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('active');
  });
});
