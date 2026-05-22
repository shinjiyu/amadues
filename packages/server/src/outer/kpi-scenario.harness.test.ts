/**
 * KPI 场景 harness — 在临时目录验证 burst 退出 → KPI 状态机，无需真实内脑进程。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createKpiScenarioFixture, type KpiScenarioFixture } from './kpi-scenario.harness.js';
import { formatKpiDigest, suggestKpiAction, buildKpiBurstLinks } from './kpi-progress.js';

describe('KPI scenario harness', () => {
  let fx: KpiScenarioFixture;

  afterEach(() => {
    fx?.cleanup();
  });

  it('场景 A：里程碑完成 + success + 产出 → KPI 自动 achieved', () => {
    fx = createKpiScenarioFixture('GitLab 贡献者评估');
    const { outcome } = fx.simulateBurstExit({
      verdict: 'success',
      deliverables: ['evaluation.md', 'contributor_report.md'],
      postComplete: true,
    });
    expect(outcome.deliverableCount).toBe(2);
    expect(outcome.autoAchieved).toBe(true);
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('achieved');
  });

  it('场景 B：失败 burst → idle streak 上升，不 achieved', () => {
    fx = createKpiScenarioFixture('EVOMAP 通信');
    fx.simulateBurstExit({ verdict: 'failed', deliverables: [], postComplete: false });
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('active');
    expect(fx.kpiRegistry.get(fx.kpiId)?.consecutiveIdleBursts).toBe(1);
  });

  it('场景 C：连续 3 次失败 → 触发反思 burst 调度', () => {
    fx = createKpiScenarioFixture('监督 Shiro');
    let lastOutcome = fx.simulateBurstExit({ verdict: 'failed', deliverables: [] }).outcome;
    lastOutcome = fx.simulateBurstExit({ verdict: 'failed', deliverables: [] }).outcome;
    lastOutcome = fx.simulateBurstExit({ verdict: 'failed', deliverables: [] }).outcome;
    const k = fx.kpiRegistry.get(fx.kpiId)!;
    expect(k.consecutiveIdleBursts).toBe(3);
    expect(k.reflexionTrail.length).toBe(3);
    expect(lastOutcome.reflexionBurstId).toMatch(/^ib-reflexion-/);
  });

  it('场景 D：AWAITING 等外部 → 不计 idle，建议 follow_up', () => {
    fx = createKpiScenarioFixture('邮件发送能力');
    fx.simulateBurstExit({
      verdict: 'failed',
      deliverables: [],
      asyncWaiting: true,
    });
    expect(fx.kpiRegistry.get(fx.kpiId)?.consecutiveIdleBursts).toBe(0);
    const k = fx.kpiRegistry.get(fx.kpiId)!;
    const links = buildKpiBurstLinks(k, fx.innerBrainRegistry);
    expect(suggestKpiAction(k, links).action).toBe('follow_up');
    const digest = formatKpiDigest(k, fx.innerBrainRegistry);
    expect(digest).toContain('follow_up');
  });

  it('场景 E：监督类未完成 post-complete → 保持 active', () => {
    fx = createKpiScenarioFixture('持续监督 Shiro');
    const { outcome } = fx.simulateBurstExit({
      verdict: 'partial',
      deliverables: ['shiro_supervision_report.md'],
      postComplete: false,
      asyncWaiting: true,
    });
    expect(outcome.autoAchieved).toBeFalsy();
    expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('active');
  });
});
