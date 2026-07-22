import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadAdvanceCursors,
  syncAdvanceCursorsFromKpiHistory,
  upsertAdvanceCursor,
} from './advance-cursor-store.js';
import type { BurstRunRecord } from './kpi-registry.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'advance-cursor-'));
}

function doneRun(finishedAt: string, deliverableCount = 1): BurstRunRecord {
  return {
    runId: 'r1',
    instanceId: 'ib-1',
    kpiId: 'kpi-1',
    startedAt: '2026-07-20T00:00:00.000Z',
    finishedAt,
    exitStatus: 'DONE',
    charter: 'x',
    ticks: 2,
    deliverableCount,
  };
}

describe('advance-cursor-store', () => {
  it('upserts and loads cursor JSON', () => {
    const root = tmpRoot();
    upsertAdvanceCursor(root, 'kpi-1', {
      bootstrapDone: true,
      sinceAt: '2026-07-21T01:00:00.000Z',
    });
    const loaded = loadAdvanceCursors(root);
    expect(loaded['kpi-1']?.bootstrapDone).toBe(true);
    expect(loaded['kpi-1']?.sinceAt).toBe('2026-07-21T01:00:00.000Z');
  });

  it('syncs bootstrapDone and sinceAt from burst history idempotently', () => {
    const root = tmpRoot();
    const finishedAt = '2026-07-21T12:00:00.000Z';
    const n = syncAdvanceCursorsFromKpiHistory(root, [
      { kpiId: 'kpi-1', burstRunHistory: [doneRun(finishedAt)] },
    ]);
    expect(n).toBe(1);
    expect(loadAdvanceCursors(root)['kpi-1']).toMatchObject({
      bootstrapDone: true,
      sinceAt: finishedAt,
    });
    expect(
      syncAdvanceCursorsFromKpiHistory(root, [
        { kpiId: 'kpi-1', burstRunHistory: [doneRun(finishedAt)] },
      ]),
    ).toBe(0);
  });

  it('syncs bootstrapDone from AWAITING exit with deliverables', () => {
    const root = tmpRoot();
    const finishedAt = '2026-07-21T15:00:00.000Z';
    const awaitingRun: BurstRunRecord = {
      runId: 'r2',
      instanceId: 'ib-2',
      kpiId: 'kpi-2',
      startedAt: '2026-07-21T14:00:00.000Z',
      finishedAt,
      exitStatus: 'AWAITING',
      charter: 'baseline',
      ticks: 3,
      deliverableCount: 2,
    };
    expect(
      syncAdvanceCursorsFromKpiHistory(root, [
        { kpiId: 'kpi-2', burstRunHistory: [awaitingRun] },
      ]),
    ).toBe(1);
    expect(loadAdvanceCursors(root)['kpi-2']).toMatchObject({
      bootstrapDone: true,
      sinceAt: finishedAt,
    });
  });
});
