import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScheduledTask } from '../openkuroneko/scheduled-tasks/scheduled-task-types.js';
import { EmployeeCalendar } from '../scheduler/employee-calendar.js';
import { DigitalEmployeeLoop } from './digital-employee-loop.js';
import { KpiRegistry } from './kpi-registry.js';
import { ConservativeSelfWorkPolicy } from './self-work-policy.js';

describe('component: digitalEmployeeLoop', () => {
  let root = '';

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('calendar due first; completion releases capacity and immediately finds KPI work', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-employee-'));
    const kpis = new KpiRegistry(root);
    const kpi = kpis.create({
      description: '持续创作并运营小说',
      createdBy: 'user',
      kind: 'ongoing',
    });
    const scheduled: ScheduledTask = {
      id: 'publish-0900',
      name: '09:00 发布',
      schedule: { type: 'once', runAt: '2026-07-21T09:00:00.000Z' },
      action: { type: 'prompt', content: '发布章节' },
      status: 'active',
      executionConfig: {
        timeoutMs: 1000,
        maxConsecutiveFailures: 3,
        retryCount: 0,
        retryIntervalMs: 1,
        onlyWhenIdle: false,
        priority: 0,
      },
      metadata: { kpiId: kpi.kpiId, expectedOutcome: '发布成功' },
      createdBy: { type: 'agent', id: 'a', name: 'agent' },
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      nextRunAt: '2026-07-21T09:00:00.000Z',
      consecutiveFailures: 0,
    };
    const triggerTask = vi.fn().mockImplementation(async () => {
      scheduled.status = 'completed';
      return { status: 'success' };
    });
    const calendar = new EmployeeCalendar({
      listTasks: vi.fn().mockImplementation(async () => [scheduled]),
      triggerTask,
    });
    const dispatchProposal = vi.fn().mockResolvedValue(undefined);
    const loop = new DigitalEmployeeLoop({
      collectEnvironment: vi.fn().mockImplementation(async () => ({
        capacity: { available: true, freeInnerSlots: 1 },
        activeKpis: kpis.list({ status: 'active' }),
        pendingDependencies: ['book-title'],
        runningConflicts: [],
        recentActions: [],
      })),
      calendar,
      selfWorkPolicy: new ConservativeSelfWorkPolicy(),
      dispatchProposal,
      maxDispatchesPerTrigger: 1,
    });

    const dueResult = await loop.trigger('calendar_due');
    expect(dueResult.reason).toBe('calendar_dispatched');
    expect(triggerTask).toHaveBeenCalledWith('publish-0900');
    expect(dispatchProposal).not.toHaveBeenCalled();

    const continuation = await loop.trigger('burst_finished');
    expect(continuation.reason).toBe('self_work_dispatched');
    expect(dispatchProposal).toHaveBeenCalledWith(
      expect.objectContaining({ kpiId: kpi.kpiId, expectedOutcome: expect.any(String) }),
    );
  });
});
