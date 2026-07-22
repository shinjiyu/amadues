import { describe, expect, it } from 'vitest';

import {
  collectAdvancePerception,
  isBootstrapDoneFromHistory,
  shouldSkipSelfWorkForKpi,
  type AdvancePerception,
} from './advance-perception.js';
import type { TaskRecord } from './inner-brain-registry.js';

function emptyPerception(overrides: Partial<AdvancePerception> = {}): AdvancePerception {
  return {
    kpiIdsWithHealthyRunning: [],
    kpiIdsWithUnhealthyRunning: [],
    kpiIdsWithInFlight: [],
    kpiIdsWithFuturePeriodicCalendar: [],
    kpiIdsBootstrapDone: [],
    kpiIdsWithRecentStall: [],
    kpiIdsNeedingRepair: [],
    sinceAtByKpi: {},
    innerByKpi: {},
    calendarByKpi: {},
    stallByKpi: {},
    stallByInstance: {},
    ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    instanceId: 'ib-1',
    workspaceId: 'ws-1',
    workDir: '/tmp/ws-1',
    goal: 'goal',
    originUser: 'u',
    originThread: 't',
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ticks: 1,
    lastTickAt: new Date().toISOString(),
    pid: 12345,
    kpiId: 'kpi-1',
    deliverableCount: 0,
    errorMessage: null,
    ...overrides,
  } as TaskRecord;
}

describe('advance perception', () => {
  it('marks in-flight and future calendar KPIs for SelfWork skip', () => {
    const perception = collectAdvancePerception({
      tasks: [task({ status: 'AWAITING', lastTickAt: null, pid: undefined })],
      calendarTasks: [
        {
          id: 'cal-1',
          name: 'daily',
          status: 'active',
          nextRunAt: new Date(Date.now() + 60_000).toISOString(),
          metadata: { kpiId: 'kpi-2', calendarKey: 'kpi-2:increment' },
        },
      ],
      kpiBootstrapFlags: [{ kpiId: 'kpi-3', bootstrapDone: true }],
    });

    expect(perception.kpiIdsWithInFlight).toContain('kpi-1');
    expect(perception.kpiIdsWithFuturePeriodicCalendar).toContain('kpi-2');
    expect(perception.kpiIdsBootstrapDone).toContain('kpi-3');
    expect(shouldSkipSelfWorkForKpi(perception, 'kpi-1')).toBe(true);
    expect(shouldSkipSelfWorkForKpi(perception, 'kpi-2')).toBe(true);
    expect(shouldSkipSelfWorkForKpi(perception, 'kpi-3')).toBe(true);
    expect(shouldSkipSelfWorkForKpi(emptyPerception(), 'kpi-x')).toBe(false);
  });

  it('maps recent stall to needingRepair when burst is no longer in flight', () => {
    const perception = collectAdvancePerception({
      tasks: [
        task({
          instanceId: 'ib-stall',
          status: 'DONE',
          kpiId: 'kpi-1',
          finishedAt: new Date().toISOString(),
        }),
      ],
      stallAlerts: [
        {
          alertId: 'a1',
          instanceId: 'ib-stall',
          severity: 'critical',
          signals: ['multi_cap_no_facts', 'long_run_no_outcome'],
          summary: 'capped without facts',
          ts: new Date().toISOString(),
        },
      ],
      kpiBootstrapFlags: [{ kpiId: 'kpi-1', bootstrapDone: true }],
    });

    expect(perception.kpiIdsWithRecentStall).toEqual(['kpi-1']);
    expect(perception.kpiIdsNeedingRepair).toEqual(['kpi-1']);
    expect(shouldSkipSelfWorkForKpi(perception, 'kpi-1')).toBe(false);
  });

  it('does not mark needingRepair while still in flight (supervision path)', () => {
    const perception = collectAdvancePerception({
      tasks: [task({ instanceId: 'ib-run', status: 'RUNNING', kpiId: 'kpi-1' })],
      stallAlerts: [
        {
          alertId: 'a1',
          instanceId: 'ib-run',
          severity: 'warn',
          signals: ['capped_nodes_3'],
          summary: 'still running',
          ts: new Date().toISOString(),
        },
      ],
    });
    expect(perception.kpiIdsWithRecentStall).toContain('kpi-1');
    expect(perception.kpiIdsNeedingRepair).not.toContain('kpi-1');
    expect(shouldSkipSelfWorkForKpi(perception, 'kpi-1')).toBe(true);
  });

  it('detects bootstrap done from burst history', () => {
    expect(isBootstrapDoneFromHistory([])).toBe(false);
    expect(
      isBootstrapDoneFromHistory([
        {
          runId: 'r1',
          instanceId: 'a',
          kpiId: 'kpi-1',
          startedAt: 't0',
          finishedAt: 't1',
          exitStatus: 'DONE',
          deliverableCount: 2,
          charter: 'x',
          ticks: 1,
        },
      ]),
    ).toBe(true);
    expect(
      isBootstrapDoneFromHistory([
        {
          runId: 'r1',
          instanceId: 'a',
          kpiId: 'kpi-1',
          startedAt: 't0',
          finishedAt: 't1',
          exitStatus: 'AWAITING',
          deliverableCount: 1,
          charter: 'x',
          ticks: 1,
        },
      ]),
    ).toBe(true);
    expect(
      isBootstrapDoneFromHistory([
        {
          runId: 'r1',
          instanceId: 'a',
          kpiId: 'kpi-1',
          startedAt: 't0',
          finishedAt: 't1',
          exitStatus: 'DONE',
          deliverableCount: 0,
          charter: 'x',
          ticks: 1,
        },
      ]),
    ).toBe(false);
  });
});
