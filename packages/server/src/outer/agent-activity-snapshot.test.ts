import { describe, expect, it } from 'vitest';

import type { TaskRecord } from './inner-brain-registry.js';
import type { KpiRecord } from './kpi-registry.js';
import {
  buildAgentActivitySnapshot,
  DEFAULT_ACTIVITY_WINDOW_MS,
} from './agent-activity-snapshot.js';

const NOW = new Date('2026-07-21T12:00:00.000Z');

function task(
  instanceId: string,
  status: TaskRecord['status'],
  startedAt: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    instanceId,
    workspaceId: `task-${instanceId}`,
    workDir: `/tmp/${instanceId}`,
    goal: `目标 ${instanceId}`,
    originUser: 'human:alice',
    status,
    startedAt,
    ...overrides,
  };
}

function kpi(kpiId: string, description: string): KpiRecord {
  return {
    kpiId,
    description,
    createdBy: 'human:alice',
    createdAt: '2026-07-20T00:00:00.000Z',
    status: 'active',
    kind: 'ongoing',
    momentum: 0,
    bursts: [],
    consecutiveIdleBursts: 0,
    isLeaf: true,
    cadence: { type: 'once' },
    burstRunHistory: [],
  };
}

describe('buildAgentActivitySnapshot', () => {
  it('builds current progress without reading workspace details', () => {
    const snapshot = buildAgentActivitySnapshot({
      tasks: [
        task('run', 'RUNNING', '2026-07-21T10:00:00.000Z', { kpiId: 'kpi-a', ticks: 4 }),
        task('blocked', 'BLOCKED', '2026-07-21T10:30:00.000Z'),
        task('wait', 'AWAITING', '2026-07-21T09:00:00.000Z'),
        task('done', 'DONE', '2026-07-21T08:00:00.000Z', {
          finishedAt: '2026-07-21T09:00:00.000Z',
          deliverableCount: 2,
        }),
        task('error', 'ERROR', '2026-07-21T07:00:00.000Z', {
          finishedAt: '2026-07-21T07:30:00.000Z',
          errorMessage: 'boom',
        }),
      ],
      kpis: [kpi('kpi-a', '小说运营')],
      maxRunningInnerBrains: 3,
      now: NOW,
    });

    expect(snapshot.progress.running.map((item) => item.instanceId)).toEqual(['run']);
    expect(snapshot.progress.blocked.map((item) => item.instanceId)).toEqual(['blocked']);
    expect(snapshot.progress.awaiting.map((item) => item.instanceId)).toEqual(['wait']);
    expect(snapshot.progress.recentTerminal.map((item) => item.instanceId)).toEqual(['done', 'error']);
    expect(snapshot.progress.activeKpis[0]?.description).toBe('小说运营');
    expect(snapshot.progress.runningSlots).toBe(1);
    expect(snapshot.progress.freeSlots).toBe(2);
  });

  it('computes 24h execution slot-time density and excludes AWAITING from execution', () => {
    const snapshot = buildAgentActivitySnapshot({
      tasks: [
        task('run', 'RUNNING', '2026-07-21T10:00:00.000Z', {
          kpiId: 'kpi-a',
          statusHistory: [{ status: 'RUNNING', at: '2026-07-21T10:00:00.000Z' }],
        }),
        task('done', 'DONE', '2026-07-21T08:00:00.000Z', {
          kpiId: 'kpi-b',
          finishedAt: '2026-07-21T09:00:00.000Z',
          statusHistory: [
            { status: 'RUNNING', at: '2026-07-21T08:00:00.000Z' },
            { status: 'DONE', at: '2026-07-21T09:00:00.000Z' },
          ],
        }),
        task('wait', 'AWAITING', '2026-07-21T07:00:00.000Z', {
          kpiId: 'kpi-a',
          statusHistory: [
            { status: 'RUNNING', at: '2026-07-21T07:00:00.000Z' },
            { status: 'AWAITING', at: '2026-07-21T08:00:00.000Z' },
          ],
        }),
        task('error', 'ERROR', '2026-07-21T09:00:00.000Z', {
          kpiId: 'kpi-b',
          finishedAt: '2026-07-21T10:00:00.000Z',
          statusHistory: [
            { status: 'RUNNING', at: '2026-07-21T09:00:00.000Z' },
            { status: 'ERROR', at: '2026-07-21T10:00:00.000Z' },
          ],
        }),
      ],
      kpis: [kpi('kpi-a', '小说运营'), kpi('kpi-b', '工具建设')],
      maxRunningInnerBrains: 2,
      now: NOW,
    });

    expect(snapshot.activity.windowMs).toBe(DEFAULT_ACTIVITY_WINDOW_MS);
    expect(snapshot.activity.executionMs).toBe(5 * 60 * 60 * 1000);
    expect(snapshot.activity.awaitingMs).toBe(4 * 60 * 60 * 1000);
    expect(snapshot.activity.density).toBeCloseTo(5 / 48);
    expect(snapshot.activity.completed).toBe(1);
    expect(snapshot.activity.failed).toBe(1);
    expect(snapshot.activity.topKpis[0]).toMatchObject({
      kpiId: 'kpi-a',
      description: '小说运营',
      executionMs: 3 * 60 * 60 * 1000,
    });
    expect(snapshot.activity.estimatedTaskCount).toBe(0);
  });

  it('clips intervals to the 24h window and estimates legacy records without statusHistory', () => {
    const snapshot = buildAgentActivitySnapshot({
      tasks: [
        task('legacy-done', 'DONE', '2026-07-20T10:00:00.000Z', {
          finishedAt: '2026-07-20T14:00:00.000Z',
        }),
        task('legacy-await', 'AWAITING', '2026-07-21T11:00:00.000Z'),
      ],
      kpis: [],
      maxRunningInnerBrains: 1,
      now: NOW,
    });

    // window starts at Jul 20 12:00, so the terminal task contributes only 2h.
    expect(snapshot.activity.executionMs).toBe(2 * 60 * 60 * 1000);
    expect(snapshot.activity.awaitingMs).toBe(60 * 60 * 1000);
    expect(snapshot.activity.estimatedTaskCount).toBe(2);
  });

  it('never reports density above 100% and protects against zero slot policy', () => {
    const tasks = Array.from({ length: 3 }, (_, index) =>
      task(`run-${index}`, 'RUNNING', '2026-07-20T12:00:00.000Z'),
    );
    const full = buildAgentActivitySnapshot({
      tasks,
      kpis: [],
      maxRunningInnerBrains: 1,
      now: NOW,
    });
    expect(full.activity.density).toBe(1);

    const zero = buildAgentActivitySnapshot({
      tasks,
      kpis: [],
      maxRunningInnerBrains: 0,
      now: NOW,
    });
    expect(zero.activity.density).toBe(0);
  });
});
