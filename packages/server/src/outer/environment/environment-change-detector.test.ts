/**
 * environmentChangeDetector 单测：派生量 + 滞回 + warmUp + 事件编排。
 * ADL: doc/structurizr/ENVIRONMENT-MODEL.md §7
 */
import { describe, expect, it } from 'vitest';
import {
  computeDelta,
  computeRatePerMin,
  computeStreakMin,
  crossedThreshold,
  runChangeDetection,
  withWarmUp,
} from './change-detector.js';
import type {
  EnvironmentSensor,
  EnvironmentSnapshot,
  FacetSample,
  FacetSeries,
} from './environment-types.js';

const MIN = 60_000;

function samples(vals: Array<[number, number]>): FacetSample<{ v: number }>[] {
  return vals.map(([at, v]) => ({ at, data: { v } }));
}

describe('computeRatePerMin', () => {
  it('每分钟增量', () => {
    const s = samples([[0, 0], [2 * MIN, 200]]);
    expect(computeRatePerMin(s, (d) => d.v)).toBe(100);
  });
  it('样本不足 → 0', () => {
    expect(computeRatePerMin(samples([[0, 5]]), (d) => d.v)).toBe(0);
  });
  it('时间跨度 0 → 0（不除零）', () => {
    expect(computeRatePerMin(samples([[10, 1], [10, 9]]), (d) => d.v)).toBe(0);
  });
});

describe('computeDelta', () => {
  it('与 windowMs 前样本差', () => {
    const s = samples([[0, 10], [1 * MIN, 12], [2 * MIN, 20]]);
    // window=1min：baseline 取 <= last.at-1min 的最新者 = at=1min(12) → 20-12=8
    expect(computeDelta(s, (d) => d.v, MIN)).toBe(8);
  });
});

describe('computeStreakMin', () => {
  it('最新连续满足的持续分钟', () => {
    const s = samples([[0, 0], [1 * MIN, 1], [2 * MIN, 1], [3 * MIN, 1]]);
    expect(computeStreakMin(s, (d) => d.v >= 1)).toBe(2); // from 1min..3min
  });
  it('最新不满足 → 0', () => {
    const s = samples([[0, 1], [1 * MIN, 0]]);
    expect(computeStreakMin(s, (d) => d.v >= 1)).toBe(0);
  });
});

describe('crossedThreshold (滞回)', () => {
  it('上行穿越 up', () => {
    expect(crossedThreshold(4, 6, 5)).toBe('up');
  });
  it('停在阈值附近不反复触发（仍 >= down）', () => {
    expect(crossedThreshold(6, 4.5, 5)).toBeNull(); // down=4 默认；4.5>=4 不触发
  });
  it('下行穿越 down', () => {
    expect(crossedThreshold(6, 3, 5)).toBe('down'); // down=4；3<4
  });
});

describe('withWarmUp', () => {
  it('样本不足 → null', () => {
    expect(withWarmUp({ length: 1 }, 2, () => 42)).toBeNull();
  });
  it('样本足 → 计算', () => {
    expect(withWarmUp({ length: 5 }, 2, () => 42)).toBe(42);
  });
});

describe('runChangeDetection', () => {
  const sensor: EnvironmentSensor<{ v: number }> = {
    id: 'x',
    label: 'x',
    description: 'x',
    cadence: 'every_tick',
    read: () => ({ v: 0 }),
    derive: (h) => ({ rate: computeRatePerMin(h.samples, (d) => d.v) }),
    detectEvents: (prev, next, _h, nowIso) =>
      prev && next.v >= 5 && prev.v < 5
        ? [{ at: nowIso, sensorId: 'x', kind: 'threshold_crossed', field: 'v', before: prev.v, after: next.v, note: 'v 上穿 5' }]
        : [],
  };

  function snap(at: number, v: number): EnvironmentSnapshot {
    return {
      capturedAt: new Date(at).toISOString(),
      agentId: 'a',
      facets: { x: { sensorId: 'x', capturedAt: new Date(at).toISOString(), data: { v }, derived: {} } },
    };
  }

  it('注入 derived 并检测事件', () => {
    const prev = snap(0, 4);
    const next = snap(2 * MIN, 6);
    const series: Record<string, FacetSeries> = {
      x: { sensorId: 'x', samples: samples([[0, 4], [2 * MIN, 6]]) },
    };
    const r = runChangeDetection([sensor as EnvironmentSensor], prev, next, series);
    expect(r.derivedById['x']?.['rate']).toBe(1); // (6-4)/2min
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.field).toBe('v');
  });

  it('sensor.derive 抛错不影响整体', () => {
    const bad: EnvironmentSensor = {
      id: 'bad', label: 'b', description: 'b', cadence: 'every_tick',
      read: () => ({}),
      derive: () => { throw new Error('boom'); },
    };
    const next = snap(0, 0);
    const r = runChangeDetection([bad], null, { ...next, facets: { bad: { sensorId: 'bad', capturedAt: next.capturedAt, data: {}, derived: {} } } }, {});
    expect(r.derivedById['bad']).toEqual({});
  });
});
