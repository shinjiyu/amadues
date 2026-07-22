/**
 * Outer calendar tools — ADL EMPLOYEE-CALENDAR.md §3
 */
import { randomUUID } from 'node:crypto';

import type { ScheduleRule, TaskAction, TaskStatus } from '../openkuroneko/scheduled-tasks/scheduled-task-types.js';
import {
  type CalendarPurpose,
  CALENDAR_PURPOSES,
  type EmployeeCalendarPort,
  assertToolCallAllowlisted,
  assertValidPurpose,
} from '../scheduler/employee-calendar.js';
import type { OuterToolContext, ToolCallResult, ToolDef } from './outer-tools.js';

export const CALENDAR_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'list_calendar',
      description:
        '列出本 agent 的日历承诺（employeeCalendar）。可按 purpose / kpi_id / status / thread 过滤。' +
        '用户问「有没有定时 / 约了什么」时必须调本工具，禁止臆测。' +
        '**禁止**说系统没有日历或 cron。',
      parameters: {
        type: 'object',
        properties: {
          purpose: {
            type: 'string',
            enum: [...CALENDAR_PURPOSES],
            description: '可选；过滤 purpose',
          },
          kpi_id: { type: 'string', description: '可选；只看某 KPI' },
          status: {
            type: 'string',
            description: '可选；active | paused | 或逗号分隔；默认 active,paused',
          },
          origin_thread: { type: 'string', description: '可选；预约来源 thread' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_commitment',
      description:
        '创建或幂等更新一条日历承诺（聊天预约 / 一次性到点派活 / KPI 周期 / 白名单 tool_call）。' +
        '业务定时与「明天下午提醒我」一律用本工具，**禁止**用内脑 wait_timer 长睡，也**禁止**说没有日历。\n' +
        'action_kind: remind=到期发 IM；spawn_goal=到期 set_goal；tool_call=到期调白名单外脑工具。',
      parameters: {
        type: 'object',
        properties: {
          purpose: {
            type: 'string',
            enum: ['chat_appointment', 'one_shot_task', 'kpi_increment', 'tool_call'],
            description: '承诺类型',
          },
          title: { type: 'string', description: '短标题' },
          when: {
            type: 'string',
            description:
              '何时执行：ISO8601 时刻 | 5 段 cron（如 0 9 * * 1）| 纯数字分钟（如 30 表示 30 分钟后）| JSON {"in_minutes":n}',
          },
          action_kind: {
            type: 'string',
            enum: ['remind', 'spawn_goal', 'tool_call'],
            description: 'remind | spawn_goal | tool_call',
          },
          expected_outcome: { type: 'string', description: '到期后期望结果简述' },
          message: {
            type: 'string',
            description: 'remind 时的 IM 正文；缺省用 title',
          },
          goal: {
            type: 'string',
            description: 'spawn_goal 时写入 set_goal 的 prompt',
          },
          tool_name: {
            type: 'string',
            description: 'tool_call 时的外脑工具名（须在日历白名单）',
          },
          tool_params_json: {
            type: 'string',
            description: '可选；tool_call 参数 JSON 对象字符串',
          },
          kpi_id: { type: 'string', description: 'kpi_increment 必填' },
          calendar_key: {
            type: 'string',
            description: '可选幂等键；缺省按 purpose 自动生成',
          },
          origin_thread: {
            type: 'string',
            description: '可选；到期回帖 thread，默认当前对话',
          },
          timezone: {
            type: 'string',
            description: 'cron 时区，默认 UTC',
          },
        },
        required: ['purpose', 'title', 'when', 'action_kind', 'expected_outcome'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_commitment',
      description: '取消一条日历承诺（按 id 或 calendar_key）。',
      parameters: {
        type: 'object',
        properties: {
          id_or_key: { type: 'string', description: '任务 id 或 calendarKey' },
        },
        required: ['id_or_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause_commitment',
      description: '暂停一条日历承诺（按 id 或 calendar_key）。',
      parameters: {
        type: 'object',
        properties: {
          id_or_key: { type: 'string', description: '任务 id 或 calendarKey' },
        },
        required: ['id_or_key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume_commitment',
      description: '恢复已暂停的日历承诺（按 id 或 calendar_key）。',
      parameters: {
        type: 'object',
        properties: {
          id_or_key: { type: 'string', description: '任务 id 或 calendarKey' },
        },
        required: ['id_or_key'],
      },
    },
  },
];

function requireCalendar(ctx: OuterToolContext): EmployeeCalendarPort {
  if (!ctx.employeeCalendar) {
    throw new Error('calendar_unavailable');
  }
  return ctx.employeeCalendar;
}

export async function execListCalendar(
  args: {
    purpose?: string;
    kpi_id?: string;
    status?: string;
    origin_thread?: string;
  },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  try {
    const calendar = requireCalendar(ctx);
    if (!calendar.listCommitments) {
      return { replied: false, output: '日历 Port 未实现 listCommitments' };
    }
    const status: TaskStatus | TaskStatus[] | undefined =
      args.status?.trim()
        ? (args.status
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) as TaskStatus[])
        : undefined;
    const purpose =
      args.purpose && CALENDAR_PURPOSES.includes(args.purpose as CalendarPurpose)
        ? (args.purpose as CalendarPurpose)
        : undefined;
    const rows = await calendar.listCommitments({
      purpose,
      kpiId: args.kpi_id?.trim() || undefined,
      status,
      originThreadId: args.origin_thread?.trim() || undefined,
    });
    if (rows.length === 0) {
      return { replied: false, output: '日历为空（无匹配承诺）。' };
    }
    const lines = rows.map((row) => {
      const bits = [
        row.id,
        row.calendarKey ? `key=${row.calendarKey}` : null,
        row.purpose ? `purpose=${row.purpose}` : null,
        `status=${row.status}`,
        row.nextRunAt ? `next=${row.nextRunAt}` : 'next=null',
        row.actionType ? `action=${row.actionType}` : null,
        row.kpiId ? `kpi=${row.kpiId}` : null,
        row.title,
      ].filter(Boolean);
      return `- ${bits.join(' | ')}`;
    });
    return { replied: false, output: `共 ${rows.length} 条：\n${lines.join('\n')}` };
  } catch (err) {
    return { replied: false, output: `list_calendar 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function execScheduleCommitment(
  args: {
    purpose?: string;
    title?: string;
    when?: string;
    action_kind?: string;
    expected_outcome?: string;
    message?: string;
    goal?: string;
    tool_name?: string;
    tool_params_json?: string;
    kpi_id?: string;
    calendar_key?: string;
    origin_thread?: string;
    timezone?: string;
  },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  try {
    const calendar = requireCalendar(ctx);
    if (!calendar.upsertCommitment) {
      return { replied: false, output: '日历 Port 未实现 upsertCommitment' };
    }
    const purposeRaw = (args.purpose ?? '').trim();
    assertValidPurpose(purposeRaw);
    const title = (args.title ?? '').trim();
    const whenRaw = (args.when ?? '').trim();
    const actionKind = (args.action_kind ?? '').trim();
    const expectedOutcome = (args.expected_outcome ?? '').trim();
    if (!title || !whenRaw || !actionKind || !expectedOutcome) {
      return {
        replied: false,
        output: 'schedule_commitment 需要 purpose/title/when/action_kind/expected_outcome',
      };
    }

    const originThread = (args.origin_thread ?? ctx.threadId).trim();
    const calendarKey =
      (args.calendar_key ?? '').trim() ||
      defaultCalendarKey(purposeRaw, {
        kpiId: args.kpi_id,
        threadId: originThread,
        title,
        toolName: args.tool_name,
      });

    const schedule = parseWhen(whenRaw, args.timezone ?? 'UTC');
    const action = buildAction(actionKind, {
      title,
      message: args.message,
      goal: args.goal,
      toolName: args.tool_name,
      toolParamsJson: args.tool_params_json,
      originThread,
    });

    const result = await calendar.upsertCommitment({
      calendarKey,
      title,
      purpose: purposeRaw,
      schedule,
      action,
      expectedOutcome,
      agentId: ctx.agentSid,
      kpiId: args.kpi_id?.trim() || undefined,
      originThreadId: originThread,
      originUserSid: ctx.inboundHumanSid,
      createdByType: ctx.inboundHumanSid ? 'user' : 'agent',
      mode: 'upsert',
    });

    const verb = result.created ? '已创建' : result.updated ? '已更新' : '已存在';
    return {
      replied: false,
      output:
        `${verb}日历承诺 id=${result.id} key=${calendarKey} purpose=${purposeRaw} ` +
        `action=${action.type} schedule=${describeSchedule(schedule)}`,
    };
  } catch (err) {
    return {
      replied: false,
      output: `schedule_commitment 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function execCancelCommitment(
  args: { id_or_key?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  try {
    const calendar = requireCalendar(ctx);
    const idOrKey = (args.id_or_key ?? '').trim();
    if (!idOrKey) return { replied: false, output: '需要 id_or_key' };
    if (!calendar.cancelCommitment) {
      return { replied: false, output: '日历 Port 未实现 cancelCommitment' };
    }
    const result = await calendar.cancelCommitment(idOrKey);
    return {
      replied: false,
      output: result.cancelled
        ? `已取消承诺 id=${result.id}`
        : `未找到承诺：${idOrKey}`,
    };
  } catch (err) {
    return {
      replied: false,
      output: `cancel_commitment 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function execPauseCommitment(
  args: { id_or_key?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  try {
    const calendar = requireCalendar(ctx);
    const idOrKey = (args.id_or_key ?? '').trim();
    if (!idOrKey) return { replied: false, output: '需要 id_or_key' };
    if (!calendar.pauseCommitment) {
      return { replied: false, output: '日历 Port 未实现 pauseCommitment' };
    }
    const result = await calendar.pauseCommitment(idOrKey);
    return {
      replied: false,
      output: result.paused ? `已暂停承诺 id=${result.id}` : `未找到承诺：${idOrKey}`,
    };
  } catch (err) {
    return {
      replied: false,
      output: `pause_commitment 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function execResumeCommitment(
  args: { id_or_key?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  try {
    const calendar = requireCalendar(ctx);
    const idOrKey = (args.id_or_key ?? '').trim();
    if (!idOrKey) return { replied: false, output: '需要 id_or_key' };
    if (!calendar.resumeCommitment) {
      return { replied: false, output: '日历 Port 未实现 resumeCommitment' };
    }
    const result = await calendar.resumeCommitment(idOrKey);
    return {
      replied: false,
      output: result.resumed ? `已恢复承诺 id=${result.id}` : `未找到承诺：${idOrKey}`,
    };
  } catch (err) {
    return {
      replied: false,
      output: `resume_commitment 失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function dispatchCalendarTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OuterToolContext,
): Promise<ToolCallResult | null> {
  switch (name) {
    case 'list_calendar':
      return execListCalendar(args as Parameters<typeof execListCalendar>[0], ctx);
    case 'schedule_commitment':
      return execScheduleCommitment(args as Parameters<typeof execScheduleCommitment>[0], ctx);
    case 'cancel_commitment':
      return execCancelCommitment(args as Parameters<typeof execCancelCommitment>[0], ctx);
    case 'pause_commitment':
      return execPauseCommitment(args as Parameters<typeof execPauseCommitment>[0], ctx);
    case 'resume_commitment':
      return execResumeCommitment(args as Parameters<typeof execResumeCommitment>[0], ctx);
    default:
      return null;
  }
}

export function defaultCalendarKey(
  purpose: CalendarPurpose,
  opts: { kpiId?: string; threadId?: string; title?: string; toolName?: string },
): string {
  const slug = slugify(opts.title ?? 'item');
  switch (purpose) {
    case 'kpi_increment':
      return `${(opts.kpiId ?? 'kpi').trim()}:increment`;
    case 'chat_appointment':
      return `chat:${opts.threadId ?? 'thread'}:${slug}`;
    case 'one_shot_task':
      return `once:${randomUUID()}`;
    case 'tool_call':
      return `tool:${opts.toolName ?? 'tool'}:${slug}`;
    case 'system':
      return `system:${slug}:${randomUUID().slice(0, 8)}`;
  }
}

export function parseWhen(whenRaw: string, timezone: string): ScheduleRule {
  const trimmed = whenRaw.trim();
  // JSON {"in_minutes": n}
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as { in_minutes?: number | string };
      const mins = Number(obj.in_minutes);
      if (!Number.isFinite(mins) || mins <= 0) {
        throw new Error('invalid in_minutes');
      }
      return {
        type: 'once',
        runAt: new Date(Date.now() + mins * 60_000).toISOString(),
      };
    } catch {
      throw new Error(`calendar_when_invalid_json:${trimmed}`);
    }
  }
  // pure minutes
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const mins = Number(trimmed);
    if (!Number.isFinite(mins) || mins <= 0) {
      throw new Error('calendar_when_invalid_minutes');
    }
    return {
      type: 'once',
      runAt: new Date(Date.now() + mins * 60_000).toISOString(),
    };
  }
  // cron: 5 whitespace-separated fields (check before Date.parse — some engines parse "0 9 * * 1")
  const cronParts = trimmed.split(/\s+/);
  if (cronParts.length === 5 && looksLikeCronField(cronParts[0]!)) {
    return { type: 'cron', expression: trimmed, timezone };
  }
  // ISO8601
  const ms = Date.parse(trimmed);
  if (!Number.isNaN(ms)) {
    return { type: 'once', runAt: new Date(ms).toISOString() };
  }
  throw new Error(`calendar_when_unparseable:${trimmed}`);
}

function looksLikeCronField(field: string): boolean {
  return (
    field === '*' ||
    /^\*\/\d+$/.test(field) ||
    /^\d+(-\d+)?(\/\d+)?$/.test(field) ||
    /^[\d*,\-\/]+$/.test(field)
  );
}

function buildAction(
  actionKind: string,
  opts: {
    title: string;
    message?: string;
    goal?: string;
    toolName?: string;
    toolParamsJson?: string;
    originThread: string;
  },
): TaskAction {
  if (actionKind === 'remind') {
    return {
      type: 'send_message',
      content: (opts.message ?? opts.title).trim() || opts.title,
      channel: opts.originThread,
    };
  }
  if (actionKind === 'spawn_goal') {
    const goal = (opts.goal ?? opts.title).trim();
    if (!goal) throw new Error('calendar_spawn_goal_requires_goal');
    return { type: 'prompt', content: goal };
  }
  if (actionKind === 'tool_call') {
    const tool = (opts.toolName ?? '').trim();
    if (!tool) throw new Error('calendar_tool_call_requires_tool_name');
    assertToolCallAllowlisted(tool);
    let params: Record<string, unknown> | undefined;
    if (opts.toolParamsJson?.trim()) {
      params = JSON.parse(opts.toolParamsJson) as Record<string, unknown>;
    }
    return { type: 'tool_call', tool, params };
  }
  throw new Error(`calendar_invalid_action_kind:${actionKind}`);
}

function describeSchedule(schedule: ScheduleRule): string {
  if (schedule.type === 'once') return `once@${schedule.runAt}`;
  if (schedule.type === 'cron') return `cron(${schedule.expression})`;
  if (schedule.type === 'interval') return `every ${schedule.intervalMs}ms`;
  return 'unknown';
}

function slugify(text: string): string {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || randomUUID().slice(0, 8);
}
