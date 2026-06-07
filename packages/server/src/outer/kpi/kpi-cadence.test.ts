import { describe, expect, it } from 'vitest';
import type { KpiRecord } from '../kpi-registry.js';
import { isCadenceDue, refreshKpiNextDueAt } from './kpi-cadence.js';

function leaf(partial: Partial<KpiRecord>): KpiRecord {
  return {
    kpiId: 'k1',
    description: 'test',
    createdBy: 'u',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    kind: 'ongoing',
    momentum: 0,
    bursts: [],
    consecutiveIdleBursts: 0,
    reflexionTrail: [],
    isLeaf: true,
    cadence: { type: 'continuous', minGapMs: 3600_000 },
    burstRunHistory: [],
    ...partial,
  };
}

describe('kpi-cadence', () => {
  it('once：无 lastBurst 则 due', () => {
    const k = leaf({ kind: 'delivery', cadence: { type: 'once' } });
    expect(isCadenceDue(k)).toBe(true);
  });

  it('continuous：minGap 未到则不 due', () => {
    const now = Date.now();
    const k = leaf({
      lastBurstAt: new Date(now - 1000).toISOString(),
      cadence: { type: 'continuous', minGapMs: 3600_000 },
    });
    expect(isCadenceDue(k, now)).toBe(false);
  });

  it('refreshKpiNextDueAt 写入间隔', () => {
    const k = leaf({ cadence: { type: 'interval', everyMs: 7200_000 } });
    const next = refreshKpiNextDueAt(k, Date.parse('2026-06-07T12:00:00.000Z'));
    expect(next).toBe('2026-06-07T14:00:00.000Z');
  });
});
