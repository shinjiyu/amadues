import { afterEach, describe, expect, it } from 'vitest';
import { shouldRecordKpiIdle } from './kpi-burst-hooks.js';
import type { ReflexionSummary } from './kpi-registry.js';
import { createKpiScenarioFixture, type KpiScenarioFixture } from './kpi-scenario.harness.js';

const baseReflexion: ReflexionSummary = {
  ts: '2026-01-01T00:00:00.000Z',
  burstInstanceId: 'ib-test',
  verdict: 'failed',
  hardFailures: [],
  softFailures: [],
  nextStrategy: '',
};

describe('shouldRecordKpiIdle', () => {
  it('failed verdict 计 idle，即使有 deliverable', () => {
    expect(shouldRecordKpiIdle({
      exitedWithError: false,
      stoppedBy: 'idle',
      deliverableCount: 2,
      reflexion: { ...baseReflexion, verdict: 'failed' },
    })).toBe(true);
  });

  it('success verdict 重置 idle', () => {
    expect(shouldRecordKpiIdle({
      exitedWithError: false,
      stoppedBy: 'idle',
      deliverableCount: 0,
      reflexion: { ...baseReflexion, verdict: 'success' },
    })).toBe(false);
  });

  it('partial + deliverable 不算 idle', () => {
    expect(shouldRecordKpiIdle({
      exitedWithError: false,
      stoppedBy: 'idle',
      deliverableCount: 1,
      reflexion: { ...baseReflexion, verdict: 'partial' },
    })).toBe(false);
  });

  it('无 reflexion 时回退 idle+零 deliverable', () => {
    expect(shouldRecordKpiIdle({
      exitedWithError: false,
      stoppedBy: 'idle',
      deliverableCount: 0,
      reflexion: null,
    })).toBe(true);
  });

  it('ERROR 退出但有 deliverable 不计 idle', () => {
    expect(shouldRecordKpiIdle({
      exitedWithError: true,
      stoppedBy: 'stop_signal',
      deliverableCount: 2,
      reflexion: null,
    })).toBe(false);
  });

  it('ERROR 退出且无 deliverable 计 idle', () => {
    expect(shouldRecordKpiIdle({
      exitedWithError: true,
      stoppedBy: 'idle',
      deliverableCount: 0,
      reflexion: null,
    })).toBe(true);
  });
});

describe('processBurstExitForKpi · 多巴胺反馈调节 (momentum)', () => {
  let fx: KpiScenarioFixture;
  afterEach(() => fx?.cleanup());

  it('success + 产出 → momentum +2', () => {
    fx = createKpiScenarioFixture('情报 KPI', 'ongoing');
    const { outcome } = fx.simulateBurstExit({
      verdict: 'success',
      deliverables: ['a.md'],
      postComplete: true,
    });
    expect(outcome.momentum).toBe(2);
    expect(fx.kpiRegistry.get(fx.kpiId)?.momentum).toBe(2);
  });

  it('failed 无产出 → momentum -2，累计后 clamp 不破下限', () => {
    fx = createKpiScenarioFixture('情报 KPI', 'ongoing');
    fx.simulateBurstExit({ verdict: 'failed', deliverables: [] });
    fx.simulateBurstExit({ verdict: 'failed', deliverables: [] });
    fx.simulateBurstExit({ verdict: 'failed', deliverables: [] });
    // -2 * 3 = -6 → clamp 到 -5
    expect(fx.kpiRegistry.get(fx.kpiId)?.momentum).toBe(-5);
  });

  it('AWAITING → momentum 不变', () => {
    fx = createKpiScenarioFixture('情报 KPI', 'ongoing');
    const { outcome } = fx.simulateBurstExit({
      verdict: 'partial',
      deliverables: ['x.md'],
      asyncWaiting: true,
    });
    expect(outcome.momentum).toBe(0);
  });
});
