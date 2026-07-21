import { describe, expect, it, vi } from 'vitest';

import { EmployeeCalendar } from './employee-calendar.js';
import type { ScheduledTask } from '../openkuroneko/scheduled-tasks/scheduled-task-types.js';

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: '发布小说',
    schedule: { type: 'once', runAt: '2026-07-21T09:00:00.000Z' },
    action: { type: 'prompt', content: '发布今天的章节' },
    status: 'active',
    executionConfig: {
      timeoutMs: 1000,
      maxConsecutiveFailures: 3,
      retryCount: 0,
      retryIntervalMs: 1,
      onlyWhenIdle: false,
      priority: 1,
    },
    metadata: { kpiId: 'kpi-1', expectedOutcome: '章节成功发布' },
    createdBy: { type: 'agent', id: 'a', name: 'agent' },
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    nextRunAt: '2026-07-21T09:00:00.000Z',
    consecutiveFailures: 0,
    ...overrides,
  };
}

describe('EmployeeCalendar', () => {
  it('does not expose future commitments and orders due commitments by priority', async () => {
    const listTasks = vi.fn().mockResolvedValue([
      task(),
      task({ id: 'task-2', nextRunAt: '2026-07-21T08:00:00.000Z', executionConfig: { ...task().executionConfig, priority: 0 } }),
      task({ id: 'future', nextRunAt: '2026-07-21T10:00:00.000Z' }),
    ]);
    const calendar = new EmployeeCalendar({ listTasks, triggerTask: vi.fn() });
    const due = await calendar.listDue(new Date('2026-07-21T09:30:00.000Z'));
    expect(due.map((item) => item.id)).toEqual(['task-2', 'task-1']);
  });

  it('keeps a due commitment pending until the loop executes it', async () => {
    const triggerTask = vi.fn().mockResolvedValue({ status: 'success' });
    const calendar = new EmployeeCalendar({
      listTasks: vi.fn().mockResolvedValue([task()]),
      triggerTask,
    });

    expect(await calendar.listDue(new Date('2026-07-21T09:30:00.000Z'))).toHaveLength(1);
    expect(triggerTask).not.toHaveBeenCalled();
    await calendar.execute('task-1');
    expect(triggerTask).toHaveBeenCalledOnce();
  });
});
