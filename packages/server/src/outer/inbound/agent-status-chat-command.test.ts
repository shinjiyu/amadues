import { describe, expect, it } from 'vitest';

import type { TaskRecord } from '../inner-brain-registry.js';
import type { KpiRecord } from '../kpi-registry.js';
import {
  formatActivityDensityReply,
  formatProgressReply,
  parseAgentStatusChatCommand,
  tryHandleAgentStatusChatCommand,
} from './agent-status-chat-command.js';

const NOW = new Date('2026-07-21T12:00:00.000Z');

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    instanceId: 'ib-run',
    workspaceId: 'task-ib-run',
    workDir: '/tmp/ib-run',
    goal: '完成小说第三章修订',
    originUser: 'human:alice',
    status: 'RUNNING',
    startedAt: '2026-07-21T10:00:00.000Z',
    ticks: 6,
    kpiId: 'kpi-a',
    ...overrides,
  };
}

function kpi(): KpiRecord {
  return {
    kpiId: 'kpi-a',
    description: '小说运营',
    createdBy: 'human:alice',
    createdAt: '2026-07-20T00:00:00.000Z',
    status: 'active',
    kind: 'ongoing',
    momentum: 2,
    bursts: ['ib-run'],
    consecutiveIdleBursts: 0,
    isLeaf: true,
    cadence: { type: 'once' },
    burstRunHistory: [],
  };
}

describe('parseAgentStatusChatCommand', () => {
  it.each(['状态', '进度', '/status', '/progress'])('%s → progress', (input) => {
    expect(parseAgentStatusChatCommand(input)).toBe('progress');
  });

  it.each(['密度', '今天', '/density', '/today'])('%s → density', (input) => {
    expect(parseAgentStatusChatCommand(input)).toBe('density');
  });

  it('only matches whole-message commands', () => {
    expect(parseAgentStatusChatCommand('今天写什么')).toBeNull();
    expect(parseAgentStatusChatCommand('看一下进度')).toBeNull();
    expect(parseAgentStatusChatCommand('状态怎么样')).toBeNull();
  });
});

describe('agent status chat reply formatting', () => {
  const snapshot = {
    tasks: [
      task(),
      task({
        instanceId: 'ib-wait',
        workspaceId: 'task-ib-wait',
        status: 'AWAITING' as const,
        goal: '等待确认书名',
        startedAt: '2026-07-21T11:00:00.000Z',
        kpiId: undefined,
      }),
      task({
        instanceId: 'ib-done',
        workspaceId: 'task-ib-done',
        status: 'DONE' as const,
        goal: '整理竞品资料',
        startedAt: '2026-07-21T08:00:00.000Z',
        finishedAt: '2026-07-21T09:00:00.000Z',
        kpiId: undefined,
      }),
    ],
    kpis: [kpi()],
    maxRunningInnerBrains: 3,
    now: NOW,
  };

  it('progress reply contains capacity, active KPI, running, waiting and recent result', () => {
    const result = tryHandleAgentStatusChatCommand({ content: '状态', ...snapshot });
    expect(result.handled).toBe(true);
    expect(result.kind).toBe('progress');
    expect(result.text).toContain('当前进度');
    expect(result.text).toContain('执行槽：1/3');
    expect(result.text).toContain('小说运营');
    expect(result.text).toContain('完成小说第三章修订');
    expect(result.text).toContain('等待确认书名');
    expect(result.text).toContain('整理竞品资料');
  });

  it('density reply contains 24h slot utilization and event counts', () => {
    const text = tryHandleAgentStatusChatCommand({ content: '密度', ...snapshot }).text;
    expect(text).toContain('过去 24 小时');
    expect(text).toContain('执行密度');
    expect(text).toContain('完成 1');
    expect(text).toContain('最活跃 KPI');
  });

  it('ordinary chat is not handled', () => {
    expect(
      tryHandleAgentStatusChatCommand({ content: '今天写什么', ...snapshot }),
    ).toEqual({ handled: false });
  });

  it('formatters keep replies compact', () => {
    const handled = tryHandleAgentStatusChatCommand({ content: '进度', ...snapshot });
    expect(handled.handled).toBe(true);
    if (!handled.handled) throw new Error('expected handled command');
    expect(formatProgressReply(handled.snapshot).length).toBeLessThan(1800);
    expect(formatActivityDensityReply(handled.snapshot).length).toBeLessThan(1800);
  });
});
