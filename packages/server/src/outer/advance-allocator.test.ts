import { describe, expect, it, vi } from 'vitest';

import {
  buildNarrowDraftProposal,
  calendarKeyForKpi,
  ensureCalendarsAfterBootstrap,
} from './advance-allocator.js';
import type { AdvancePerception } from './advance-perception.js';

function perception(overrides: Partial<AdvancePerception> = {}): AdvancePerception {
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

const kpi = {
  kpiId: 'kpi-1',
  description: '每日采集行业新闻',
  status: 'active' as const,
  notes: '',
  charter: '长职责全文……',
  momentum: 1,
};

describe('advance allocator', () => {
  it('proposes narrow bootstrap when no baseline', () => {
    const proposal = buildNarrowDraftProposal(kpi, perception(), 'conservative');
    expect(proposal?.action).toContain('bootstrap');
    expect(proposal?.action).not.toContain(kpi.charter);
  });

  it('skips when healthy running / future calendar / bootstrap done', () => {
    expect(
      buildNarrowDraftProposal(
        kpi,
        perception({ kpiIdsWithHealthyRunning: ['kpi-1'] }),
        'conservative',
      ),
    ).toBeNull();
    expect(
      buildNarrowDraftProposal(
        kpi,
        perception({ kpiIdsWithFuturePeriodicCalendar: ['kpi-1'] }),
        'conservative',
      ),
    ).toBeNull();
    expect(
      buildNarrowDraftProposal(kpi, perception({ kpiIdsBootstrapDone: ['kpi-1'] }), 'conservative'),
    ).toBeNull();
  });

  it('proposes repair when needingRepair even if bootstrap done', () => {
    const proposal = buildNarrowDraftProposal(
      kpi,
      perception({
        kpiIdsBootstrapDone: ['kpi-1'],
        kpiIdsNeedingRepair: ['kpi-1'],
        kpiIdsWithRecentStall: ['kpi-1'],
        stallByKpi: {
          'kpi-1': [
            {
              alertId: 'a1',
              instanceId: 'ib-1',
              kpiId: 'kpi-1',
              severity: 'critical',
              signals: ['multi_cap_no_facts'],
              summary: 'no facts after caps',
              ts: new Date().toISOString(),
            },
          ],
        },
      }),
      'conservative',
    );
    expect(proposal?.action).toContain('repair');
    expect(proposal?.action).toContain('multi_cap_no_facts');
  });

  it('ensure skips KPIs that need repair first', async () => {
    const ensure = vi.fn().mockResolvedValue({ created: true, id: 't1' });
    const outcome = await ensureCalendarsAfterBootstrap({
      kpis: [kpi],
      perception: perception({
        kpiIdsBootstrapDone: ['kpi-1'],
        kpiIdsNeedingRepair: ['kpi-1'],
      }),
      agentId: 'agent-1',
      ensure,
    });
    expect(outcome.created).toBe(0);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('ensures one periodic calendar after bootstrap (ADV-6 idempotent key)', async () => {
    const ensure = vi.fn().mockResolvedValue({ created: true, id: 't1' });
    const outcome = await ensureCalendarsAfterBootstrap({
      kpis: [kpi],
      perception: perception({ kpiIdsBootstrapDone: ['kpi-1'] }),
      agentId: 'agent-1',
      ensure,
    });
    expect(outcome.created).toBe(1);
    expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarKey: calendarKeyForKpi('kpi-1'),
        kpiId: 'kpi-1',
      }),
    );

    ensure.mockClear();
    const skipped = await ensureCalendarsAfterBootstrap({
      kpis: [kpi],
      perception: perception({
        kpiIdsBootstrapDone: ['kpi-1'],
        kpiIdsWithFuturePeriodicCalendar: ['kpi-1'],
      }),
      agentId: 'agent-1',
      ensure,
    });
    expect(skipped.created).toBe(0);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('injects sinceAt into periodic increment prompt', async () => {
    const ensure = vi.fn().mockResolvedValue({ created: true, id: 't1' });
    await ensureCalendarsAfterBootstrap({
      kpis: [kpi],
      perception: perception({
        kpiIdsBootstrapDone: ['kpi-1'],
        sinceAtByKpi: { 'kpi-1': '2026-07-21T00:00:00.000Z' },
      }),
      agentId: 'agent-1',
      ensure,
    });
    expect(ensure.mock.calls[0]![0].prompt).toContain('2026-07-21T00:00:00.000Z');
  });
});
