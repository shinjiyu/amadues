import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SelfWorkMetricsTracker,
  summarizeSelfWorkMetrics,
  type SelfWorkMetricEvent,
} from './self-work-metrics.js';

function event(overrides: Partial<SelfWorkMetricEvent> = {}): SelfWorkMetricEvent {
  return {
    at: '2026-07-21T00:00:00.000Z',
    kind: 'accepted',
    reason: 'self_work_dispatched',
    strategyId: 'conservative',
    ...overrides,
  };
}

describe('summarizeSelfWorkMetrics', () => {
  it('acceptance / duplicate rate / no-progress streak / byStrategy', () => {
    const summary = summarizeSelfWorkMetrics([
      event(),
      event({ kind: 'rejected', reason: 'duplicate_action' }),
      event({ kind: 'rejected', reason: 'route_blocked', strategyId: 'balanced' }),
      event({ kind: 'accepted', strategyId: 'balanced' }),
      event({ kind: 'slept', reason: 'no_valuable_work', strategyId: undefined }),
      event({ kind: 'rejected', reason: 'running_conflict' }),
    ]);

    expect(summary.total).toBe(6);
    expect(summary.accepted).toBe(2);
    expect(summary.rejected).toBe(3);
    expect(summary.acceptanceRate).toBeCloseTo(2 / 5);
    expect(summary.duplicateRate).toBeCloseTo(2 / 5);
    expect(summary.noProgressStreak).toBe(2);
    expect(summary.byStrategy['conservative']).toEqual({ accepted: 1, rejected: 2 });
    expect(summary.byStrategy['balanced']).toEqual({ accepted: 1, rejected: 1 });
  });

  it('空事件 → 全零', () => {
    const summary = summarizeSelfWorkMetrics([]);
    expect(summary.acceptanceRate).toBe(0);
    expect(summary.duplicateRate).toBe(0);
    expect(summary.noProgressStreak).toBe(0);
  });
});

describe('SelfWorkMetricsTracker', () => {
  let tmp = '';
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('record → JSONL 落盘，read/summarize 可回放', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-metrics-'));
    const tracker = new SelfWorkMetricsTracker(tmp);
    tracker.record(event());
    tracker.record(event({ kind: 'rejected', reason: 'duplicate_action' }));

    const file = path.join(tmp, 'autonomy', 'self-work-metrics.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    expect(tracker.read().length).toBe(2);
    expect(tracker.summarize().accepted).toBe(1);
    expect(tracker.summarize().noProgressStreak).toBe(1);
  });

  it('无文件时 read 返回空且不抛错', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-metrics-'));
    const tracker = new SelfWorkMetricsTracker(tmp);
    expect(tracker.read()).toEqual([]);
    expect(tracker.summarize().total).toBe(0);
  });
});
