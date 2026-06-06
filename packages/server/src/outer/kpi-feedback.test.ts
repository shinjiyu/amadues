/**
 * kpi-feedback 单元测试（多巴胺反馈调节）
 *
 * ADL: doc/structurizr/STRATEGY-PLANNING-LAYER.md §16
 *
 * 守门：computeMomentumDelta 必须 deterministic（同输入同输出）；
 * selectKpiByMomentum 必须按 momentum 降序、平手按 createdAt 新者优先。
 */
import { describe, expect, it } from 'vitest';
import { computeMomentumDelta, selectKpiByMomentum } from './kpi-feedback.js';
import type { KpiRecord } from './kpi-registry.js';

function makeKpi(overrides: Partial<KpiRecord> = {}): KpiRecord {
  return {
    kpiId: 'kpi-x',
    description: 't',
    createdBy: 'u',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    kind: 'delivery',
    momentum: 0,
    bursts: [],
    consecutiveIdleBursts: 0,
    reflexionTrail: [],
    ...overrides,
  };
}

describe('computeMomentumDelta', () => {
  it('isAwaiting → 0（不奖不罚，先于一切）', () => {
    expect(
      computeMomentumDelta({ verdict: 'failed', deliverableCount: 0, isAwaiting: true, exitedWithError: true }),
    ).toBe(0);
  });

  it('exitedWithError → -2（先于 verdict）', () => {
    expect(
      computeMomentumDelta({ verdict: 'success', deliverableCount: 5, isAwaiting: false, exitedWithError: true }),
    ).toBe(-2);
  });

  it('success：有产出 +2、无产出 +1', () => {
    expect(computeMomentumDelta({ verdict: 'success', deliverableCount: 3, isAwaiting: false, exitedWithError: false })).toBe(2);
    expect(computeMomentumDelta({ verdict: 'success', deliverableCount: 0, isAwaiting: false, exitedWithError: false })).toBe(1);
  });

  it('partial：有产出 +1、无产出 0', () => {
    expect(computeMomentumDelta({ verdict: 'partial', deliverableCount: 1, isAwaiting: false, exitedWithError: false })).toBe(1);
    expect(computeMomentumDelta({ verdict: 'partial', deliverableCount: 0, isAwaiting: false, exitedWithError: false })).toBe(0);
  });

  it('failed → -2', () => {
    expect(computeMomentumDelta({ verdict: 'failed', deliverableCount: 0, isAwaiting: false, exitedWithError: false })).toBe(-2);
  });

  it('无 reflexion：有产出 +1、空转 -1', () => {
    expect(computeMomentumDelta({ verdict: null, deliverableCount: 2, isAwaiting: false, exitedWithError: false })).toBe(1);
    expect(computeMomentumDelta({ verdict: null, deliverableCount: 0, isAwaiting: false, exitedWithError: false })).toBe(-1);
  });

  it('deterministic：同输入多次同输出', () => {
    const sig = { verdict: 'partial' as const, deliverableCount: 1, isAwaiting: false, exitedWithError: false };
    const a = computeMomentumDelta(sig);
    const b = computeMomentumDelta(sig);
    expect(a).toBe(b);
  });
});

describe('selectKpiByMomentum', () => {
  it('空列表 → undefined', () => {
    expect(selectKpiByMomentum([])).toBeUndefined();
  });

  it('选 momentum 最高者', () => {
    const lo = makeKpi({ kpiId: 'lo', momentum: -1 });
    const hi = makeKpi({ kpiId: 'hi', momentum: 4 });
    const mid = makeKpi({ kpiId: 'mid', momentum: 1 });
    expect(selectKpiByMomentum([lo, hi, mid])?.kpiId).toBe('hi');
  });

  it('momentum 平手 → createdAt 新者优先', () => {
    const older = makeKpi({ kpiId: 'old', momentum: 2, createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = makeKpi({ kpiId: 'new', momentum: 2, createdAt: '2026-02-01T00:00:00.000Z' });
    expect(selectKpiByMomentum([older, newer])?.kpiId).toBe('new');
  });

  it('不修改入参数组', () => {
    const arr = [makeKpi({ kpiId: 'a', momentum: 1 }), makeKpi({ kpiId: 'b', momentum: 3 })];
    const snapshot = arr.map((k) => k.kpiId);
    selectKpiByMomentum(arr);
    expect(arr.map((k) => k.kpiId)).toEqual(snapshot);
  });
});
