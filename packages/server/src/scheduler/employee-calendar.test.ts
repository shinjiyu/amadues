import { describe, expect, it, vi } from 'vitest';

import {
  CALENDAR_DUE_TOOL_CALL_ALLOWLIST,
  EmployeeCalendar,
  MAX_ACTIVE_CALENDAR_COMMITMENTS,
  assertScheduleFloor,
  assertToolCallAllowlisted,
} from './employee-calendar.js';
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
      task({
        id: 'task-2',
        nextRunAt: '2026-07-21T08:00:00.000Z',
        executionConfig: { ...task().executionConfig, priority: 0 },
      }),
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

  it('ensurePeriodicCommitment is idempotent by calendarKey', async () => {
    const existing = task({
      id: 'existing',
      metadata: {
        kpiId: 'kpi-1',
        calendarKey: 'kpi-1:increment',
        seedKind: 'increment',
        purpose: 'kpi_increment',
        expectedOutcome: 'ok',
      },
      nextRunAt: '2026-07-22T01:00:00.000Z',
    });
    const createTask = vi.fn();
    const calendar = new EmployeeCalendar({
      listTasks: vi.fn().mockResolvedValue([existing]),
      triggerTask: vi.fn(),
      createTask,
    });
    const result = await calendar.ensurePeriodicCommitment({
      calendarKey: 'kpi-1:increment',
      kpiId: 'kpi-1',
      title: '增量',
      expectedOutcome: '报告',
      prompt: '采集增量',
      agentId: 'agent-1',
    });
    expect(result).toEqual({ created: false, id: 'existing' });
    expect(createTask).not.toHaveBeenCalled();
  });

  it('ensurePeriodicCommitment creates when missing via upsert ensure', async () => {
    const createTask = vi.fn().mockResolvedValue('new-id');
    const calendar = new EmployeeCalendar({
      listTasks: vi.fn().mockResolvedValue([]),
      triggerTask: vi.fn(),
      createTask,
    });
    const result = await calendar.ensurePeriodicCommitment({
      calendarKey: 'kpi-1:increment',
      kpiId: 'kpi-1',
      title: '增量',
      expectedOutcome: '报告',
      prompt: '采集增量',
      agentId: 'agent-1',
    });
    expect(result).toEqual({ created: true, id: 'new-id' });
    expect(createTask).toHaveBeenCalledOnce();
    const req = createTask.mock.calls[0]![0];
    expect(req.metadata.purpose).toBe('kpi_increment');
    expect(req.metadata.calendarKey).toBe('kpi-1:increment');
  });

  it('upsertCommitment remind is idempotent by calendarKey and can update', async () => {
    const existing = task({
      id: 'appt-1',
      name: '旧标题',
      action: { type: 'send_message', content: '旧', channel: 't1' },
      metadata: {
        purpose: 'chat_appointment',
        calendarKey: 'chat:t1:meet',
        expectedOutcome: '提醒',
      },
    });
    const updateTask = vi.fn().mockResolvedValue(existing);
    const createTask = vi.fn();
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([existing]);
    const calendar = new EmployeeCalendar({
      listTasks,
      triggerTask: vi.fn(),
      createTask,
      updateTask,
    });

    const first = await calendar.upsertCommitment({
      calendarKey: 'chat:t1:meet',
      title: '开会提醒',
      purpose: 'chat_appointment',
      schedule: { type: 'once', runAt: '2026-07-23T07:00:00.000Z' },
      action: { type: 'send_message', content: '开会啦', channel: 't1' },
      expectedOutcome: '用户收到提醒',
      agentId: 'agent-1',
      originThreadId: 't1',
      mode: 'upsert',
    });
    expect(first).toEqual({ created: false, id: 'appt-1', updated: true });
    expect(createTask).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledOnce();
  });

  it('kpi_increment and chat_appointment can coexist', async () => {
    const createTask = vi.fn().mockResolvedValueOnce('kpi-cal').mockResolvedValueOnce('chat-cal');
    const listTasks = vi.fn().mockResolvedValue([]);
    const calendar = new EmployeeCalendar({
      listTasks,
      triggerTask: vi.fn(),
      createTask,
    });
    await calendar.upsertCommitment({
      calendarKey: 'kpi-1:increment',
      title: '日增',
      purpose: 'kpi_increment',
      schedule: { type: 'cron', expression: '0 1 * * *', timezone: 'UTC' },
      action: { type: 'prompt', content: '增量' },
      expectedOutcome: '报告',
      agentId: 'a',
      kpiId: 'kpi-1',
    });
    await calendar.upsertCommitment({
      calendarKey: 'chat:t1:meet',
      title: '开会',
      purpose: 'chat_appointment',
      schedule: { type: 'once', runAt: '2026-07-23T07:00:00.000Z' },
      action: { type: 'send_message', content: '开会', channel: 't1' },
      expectedOutcome: '提醒',
      agentId: 'a',
      originThreadId: 't1',
    });
    expect(createTask).toHaveBeenCalledTimes(2);
  });

  it('distinct kpi_increment calendarKeys for same kpi do not collapse via legacy seedKind', async () => {
    const morning = task({
      id: 'm1',
      metadata: {
        kpiId: 'kpi-1',
        calendarKey: 'kpi-1:increment:morning',
        seedKind: 'increment',
        purpose: 'kpi_increment',
      },
    });
    const createTask = vi.fn().mockResolvedValue('m2');
    const updateTask = vi.fn();
    const calendar = new EmployeeCalendar({
      listTasks: vi.fn().mockResolvedValue([morning]),
      triggerTask: vi.fn(),
      createTask,
      updateTask,
    });
    const noon = await calendar.upsertCommitment({
      calendarKey: 'kpi-1:increment:noon',
      title: '午班',
      purpose: 'kpi_increment',
      schedule: { type: 'cron', expression: '0 13 * * *', timezone: 'Asia/Shanghai' },
      action: { type: 'prompt', content: '午增量' },
      expectedOutcome: '报告',
      agentId: 'a',
      kpiId: 'kpi-1',
    });
    expect(noon.created).toBe(true);
    expect(createTask).toHaveBeenCalledOnce();
    expect(updateTask).not.toHaveBeenCalled();
  });

  it('cancel / pause / resume resolve by calendarKey', async () => {
    const existing = task({
      id: 'x1',
      metadata: { calendarKey: 'chat:t1:a', purpose: 'chat_appointment' },
    });
    const deleteTask = vi.fn().mockResolvedValue(true);
    const pauseTask = vi.fn().mockResolvedValue(existing);
    const resumeTask = vi.fn().mockResolvedValue(existing);
    const calendar = new EmployeeCalendar({
      listTasks: vi.fn().mockResolvedValue([existing]),
      triggerTask: vi.fn(),
      deleteTask,
      pauseTask,
      resumeTask,
    });
    expect(await calendar.pauseCommitment('chat:t1:a')).toEqual({ paused: true, id: 'x1' });
    expect(await calendar.resumeCommitment('chat:t1:a')).toEqual({ resumed: true, id: 'x1' });
    expect(await calendar.cancelCommitment('chat:t1:a')).toEqual({ cancelled: true, id: 'x1' });
  });

  it('rejects non-allowlisted tool_call and too-frequent schedules', () => {
    expect(() => assertToolCallAllowlisted('set_goal')).toThrow(/not_allowlisted/);
    expect(() => assertToolCallAllowlisted('list_kpis')).not.toThrow();
    expect(CALENDAR_DUE_TOOL_CALL_ALLOWLIST.has('list_calendar')).toBe(true);
    expect(() =>
      assertScheduleFloor({ type: 'interval', intervalMs: 60_000 }),
    ).toThrow(/too_frequent/);
    expect(() =>
      assertScheduleFloor({ type: 'cron', expression: '* * * * *', timezone: 'UTC' }),
    ).toThrow(/cron_too_frequent/);
  });

  it('enforces active commitment cap', async () => {
    const many = Array.from({ length: MAX_ACTIVE_CALENDAR_COMMITMENTS }, (_, i) =>
      task({ id: `t-${i}`, metadata: { calendarKey: `k-${i}` } }),
    );
    const calendar = new EmployeeCalendar({
      listTasks: vi.fn().mockResolvedValue(many),
      triggerTask: vi.fn(),
      createTask: vi.fn(),
    });
    await expect(
      calendar.upsertCommitment({
        calendarKey: 'overflow',
        title: 'x',
        purpose: 'chat_appointment',
        schedule: { type: 'once', runAt: '2026-08-01T00:00:00.000Z' },
        action: { type: 'send_message', content: 'x', channel: 't' },
        expectedOutcome: 'x',
        agentId: 'a',
      }),
    ).rejects.toThrow(/calendar_active_cap/);
  });
});
