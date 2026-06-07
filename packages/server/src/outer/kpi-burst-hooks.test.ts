import { afterEach, describe, expect, it } from 'vitest';
import { shouldRecordKpiIdle, processBurstExitForKpi } from './kpi-burst-hooks.js';
import { createKpiScenarioFixture, type KpiScenarioFixture } from './kpi-scenario.harness.js';

describe('shouldRecordKpiIdle', () => {
  it('successConfirmed 不计 idle', () => {
    expect(shouldRecordKpiIdle({
      exitedWithError: false,
      stoppedBy: 'idle',
      deliverableCount: 2,
      successConfirmed: true,
    })).toBe(false);
  });

  it('无产出且未确认成功 → idle', () => {
    expect(shouldRecordKpiIdle({
      exitedWithError: false,
      stoppedBy: 'idle',
      deliverableCount: 0,
      successConfirmed: false,
    })).toBe(true);
  });

  it('AWAITING 不增 streak', () => {
    expect(shouldRecordKpiIdle({
      exitedWithError: false,
      stoppedBy: 'idle',
      deliverableCount: 0,
      isAwaiting: true,
    })).toBe(false);
  });

  it('ERROR 且无 deliverable 计 idle', () => {
    expect(shouldRecordKpiIdle({
      exitedWithError: true,
      stoppedBy: 'stop_signal',
      deliverableCount: 0,
    })).toBe(true);
  });
});

describe('processBurstExitForKpi · outcome evaluation', () => {
  let fx: KpiScenarioFixture;
  afterEach(() => fx?.cleanup());

  it('有 deliverable → outcomeEvaluation.successConfirmed + momentum', () => {
    fx = createKpiScenarioFixture('情报 KPI', 'ongoing');
    const { outcome } = fx.simulateBurstExit({
      deliverables: ['a.md'],
      postComplete: true,
    });
    expect(outcome.outcomeEvaluation?.successConfirmed).toBe(true);
    expect(outcome.reflexionBurstId).toBeNull();
    expect(fx.kpiRegistry.get(fx.kpiId)?.burstRunHistory.at(-1)?.outcomeEvaluation).toBeDefined();
  });

  it('无 deliverable → 建议重试 charter 写入 KPI', () => {
    fx = createKpiScenarioFixture('交付 KPI', 'delivery');
    const { outcome } = fx.simulateBurstExit({ deliverables: [] });
    expect(outcome.outcomeEvaluation?.successConfirmed).toBe(false);
    expect(outcome.nextKpiBurstId).toBe('ib-next-1');
    expect(fx.kpiRegistry.get(fx.kpiId)?.charter).toMatch(/换向重试/);
    expect(fx.nextBurstsScheduled).toContain(fx.kpiId);
  });
});
