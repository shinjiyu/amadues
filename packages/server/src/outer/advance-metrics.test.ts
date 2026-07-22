import { describe, expect, it } from 'vitest';

import {
  detectAdvancePackageKind,
  summarizeAdvanceMetrics,
  type AdvanceMetricEvent,
} from './advance-metrics.js';

describe('advance-metrics', () => {
  it('detects package kind from action text', () => {
    expect(detectAdvancePackageKind('【本轮工作包·bootstrap】做基线')).toBe('bootstrap');
    expect(detectAdvancePackageKind('【本轮工作包·repair】修缺口')).toBe('repair');
    expect(detectAdvancePackageKind('【日历到期·increment】增量')).toBe('increment');
    expect(detectAdvancePackageKind('随便推进')).toBe('other');
  });

  it('computes blindDispatchRate and duplicate calendar creates', () => {
    const events: AdvanceMetricEvent[] = [
      {
        at: 't1',
        kind: 'dispatch',
        kpiId: 'k1',
        packageKind: 'bootstrap',
        hadPerception: true,
      },
      {
        at: 't2',
        kind: 'dispatch',
        kpiId: 'k2',
        packageKind: 'other',
        hadPerception: false,
      },
      {
        at: 't3',
        kind: 'calendar_ensure',
        kpiId: 'k1',
        calendarKey: 'k1:increment',
        created: true,
        hadPerception: true,
      },
      {
        at: 't4',
        kind: 'calendar_ensure',
        kpiId: 'k1',
        calendarKey: 'k1:increment',
        created: false,
        hadPerception: true,
      },
      {
        at: 't5',
        kind: 'calendar_ensure',
        kpiId: 'k1',
        calendarKey: 'k1:increment',
        created: true,
        hadPerception: true,
      },
    ];
    const summary = summarizeAdvanceMetrics(events);
    expect(summary.dispatches).toBe(2);
    expect(summary.blindDispatches).toBe(1);
    expect(summary.blindDispatchRate).toBe(0.5);
    expect(summary.calendarEnsureCreated).toBe(2);
    expect(summary.calendarEnsureNoops).toBe(1);
    expect(summary.duplicateCalendarCreates).toBe(1);
  });

  it('healthy ADV-6 path has zero duplicate creates', () => {
    const summary = summarizeAdvanceMetrics([
      {
        at: 't1',
        kind: 'calendar_ensure',
        calendarKey: 'k1:increment',
        created: true,
        hadPerception: true,
      },
      {
        at: 't2',
        kind: 'calendar_ensure',
        calendarKey: 'k1:increment',
        created: false,
        hadPerception: true,
      },
    ]);
    expect(summary.duplicateCalendarCreates).toBe(0);
  });
});
