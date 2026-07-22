import { describe, expect, it, vi } from 'vitest';

import {
  defaultCalendarKey,
  dispatchCalendarTool,
  parseWhen,
} from './calendar-tools.js';
import { OUTER_TOOL_DEFS, executeOuterTool, type OuterToolContext } from './outer-tools.js';
import type { EmployeeCalendarPort } from '../scheduler/employee-calendar.js';

function mockCtx(calendar: EmployeeCalendarPort): OuterToolContext {
  return {
    threadId: 'thread-1',
    agentSid: 'agent-1',
    workspaceId: 'ws-1',
    imClient: { postMessage: vi.fn() } as unknown as OuterToolContext['imClient'],
    assetStore: {} as OuterToolContext['assetStore'],
    getEngine: () => {
      throw new Error('unused');
    },
    workspaceStore: {} as OuterToolContext['workspaceStore'],
    repoStore: {} as OuterToolContext['repoStore'],
    dataRoot: '/tmp',
    employeeCalendar: calendar,
  };
}

describe('calendar-tools', () => {
  it('exposes calendar tools on OUTER_TOOL_DEFS', () => {
    const names = OUTER_TOOL_DEFS.map((t) => t.function.name);
    expect(names).toContain('list_calendar');
    expect(names).toContain('schedule_commitment');
    expect(names).toContain('cancel_commitment');
    expect(names).toContain('pause_commitment');
    expect(names).toContain('resume_commitment');
  });

  it('parseWhen accepts ISO, minutes, cron, and in_minutes JSON', () => {
    expect(parseWhen('2026-07-23T07:00:00.000Z', 'UTC')).toEqual({
      type: 'once',
      runAt: '2026-07-23T07:00:00.000Z',
    });
    const mins = parseWhen('30', 'UTC');
    expect(mins.type).toBe('once');
    if (mins.type === 'once') {
      expect(Date.parse(mins.runAt)).toBeGreaterThan(Date.now());
    }
    expect(parseWhen('0 9 * * 1', 'Asia/Shanghai')).toEqual({
      type: 'cron',
      expression: '0 9 * * 1',
      timezone: 'Asia/Shanghai',
    });
    const fromJson = parseWhen('{"in_minutes":15}', 'UTC');
    expect(fromJson.type).toBe('once');
  });

  it('defaultCalendarKey follows purpose conventions', () => {
    expect(defaultCalendarKey('kpi_increment', { kpiId: 'kpi-9' })).toBe('kpi-9:increment');
    expect(defaultCalendarKey('chat_appointment', { threadId: 't1', title: '开会 Reminder' })).toMatch(
      /^chat:t1:/,
    );
    expect(defaultCalendarKey('one_shot_task', {})).toMatch(/^once:/);
    expect(defaultCalendarKey('tool_call', { toolName: 'list_kpis', title: 'poll' })).toMatch(
      /^tool:list_kpis:/,
    );
  });

  it('schedule_commitment remind upserts via Port', async () => {
    const upsertCommitment = vi.fn().mockResolvedValue({
      created: true,
      id: 'new-1',
      updated: false,
    });
    const calendar: EmployeeCalendarPort = {
      listDue: async () => [],
      execute: async () => undefined,
      upsertCommitment,
      listCommitments: async () => [],
    };
    const out = await dispatchCalendarTool(
      'schedule_commitment',
      {
        purpose: 'chat_appointment',
        title: '提醒开会',
        when: '2026-07-23T07:00:00.000Z',
        action_kind: 'remind',
        expected_outcome: '用户收到提醒',
        message: '三点开会',
      },
      mockCtx(calendar),
    );
    expect(out?.output).toMatch(/已创建/);
    expect(upsertCommitment).toHaveBeenCalledOnce();
    const input = upsertCommitment.mock.calls[0]![0];
    expect(input.purpose).toBe('chat_appointment');
    expect(input.action).toEqual({
      type: 'send_message',
      content: '三点开会',
      channel: 'thread-1',
    });
    expect(input.calendarKey).toMatch(/^chat:thread-1:/);
  });

  it('executeOuterTool routes schedule_commitment', async () => {
    const upsertCommitment = vi.fn().mockResolvedValue({
      created: false,
      id: 'x',
      updated: true,
    });
    const result = await executeOuterTool(
      'schedule_commitment',
      JSON.stringify({
        purpose: 'chat_appointment',
        title: '提醒',
        when: '60',
        action_kind: 'remind',
        expected_outcome: 'ok',
        calendar_key: 'chat:thread-1:fixed',
      }),
      mockCtx({
        listDue: async () => [],
        execute: async () => undefined,
        upsertCommitment,
      }),
    );
    expect(result.output).toMatch(/已更新|已存在|已创建/);
    expect(upsertCommitment).toHaveBeenCalled();
  });

  it('rejects spawn without goal and non-allowlisted tool', async () => {
    const calendar: EmployeeCalendarPort = {
      listDue: async () => [],
      execute: async () => undefined,
      upsertCommitment: vi.fn(),
    };
    const badTool = await dispatchCalendarTool(
      'schedule_commitment',
      {
        purpose: 'tool_call',
        title: 'hack',
        when: '10',
        action_kind: 'tool_call',
        expected_outcome: 'x',
        tool_name: 'set_goal',
      },
      mockCtx(calendar),
    );
    expect(badTool?.output).toMatch(/not_allowlisted|失败/);
  });
});
