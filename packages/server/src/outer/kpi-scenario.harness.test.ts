/**
 * KPI 场景 harness — 在临时目录验证 burst 工作区与 registry 行，不跑 hook / 不 spawn。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createKpiScenarioFixture, type KpiScenarioFixture } from './kpi-scenario.harness.js';
import { formatKpiDigest, suggestKpiAction, buildKpiBurstLinks } from './kpi-progress.js';
import { sweepKpiCompletions } from './kpi-completion-judge.js';

describe('KPI scenario harness', () => {
  let fx: KpiScenarioFixture;

  afterEach(() => {
    fx?.cleanup();
  });

  it('场景 A：里程碑完成 + success + 产出 → registry DONE，sweep 后 achieved', () => {
    fx = createKpiScenarioFixture('GitLab 贡献者评估');
    const { deliverableCount } = fx.simulateBurstExit({
      verdict: 'success',
      deliverables: ['evaluation.md', 'contributor_report.md'],
      postComplete: true,
    });
    expect(deliverableCount).toBe(2);
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('active');
    const r = sweepKpiCompletions(fx.kpiRegistry, fx.innerBrainRegistry);
    expect(r.marked).toContain(fx.kpiId);
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('achieved');
  });

  it('场景 B：失败 burst → KPI 保持 active（onExit 不记 idle streak）', () => {
    fx = createKpiScenarioFixture('EVOMAP 通信');
    fx.simulateBurstExit({ verdict: 'failed', deliverables: [], postComplete: false });
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('active');
    expect(fx.kpiRegistry.get(fx.kpiId)?.consecutiveIdleBursts ?? 0).toBe(0);
  });

  it('场景 D：AWAITING 等外部 → 建议 follow_up', () => {
    fx = createKpiScenarioFixture('邮件发送能力');
    fx.simulateBurstExit({
      verdict: 'failed',
      deliverables: [],
      asyncWaiting: true,
    });
    const k = fx.kpiRegistry.get(fx.kpiId)!;
    const links = buildKpiBurstLinks(k, fx.innerBrainRegistry);
    expect(suggestKpiAction(k, links).action).toBe('follow_up');
    const digest = formatKpiDigest(k, fx.innerBrainRegistry);
    expect(digest).toContain('follow_up');
  });

  it('场景 E：监督类 AWAITING → 保持 active', () => {
    fx = createKpiScenarioFixture('持续监督 Shiro');
    fx.simulateBurstExit({
      verdict: 'partial',
      deliverables: ['shiro_supervision_report.md'],
      postComplete: false,
      asyncWaiting: true,
    });
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('active');
    const r = sweepKpiCompletions(fx.kpiRegistry, fx.innerBrainRegistry);
    expect(r.marked).toHaveLength(0);
  });
});
