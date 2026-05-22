import { describe, expect, it } from 'vitest';
import { shouldRecordKpiIdle } from './kpi-burst-hooks.js';
import type { ReflexionSummary } from './kpi-registry.js';

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
});
