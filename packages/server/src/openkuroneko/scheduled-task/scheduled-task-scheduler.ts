/**
 * Legacy tool-layer compatibility for old scheduled-task tool calls.
 *
 * This file now delegates to the canonical scheduled-tasks bridge instead of
 * maintaining a second scheduler implementation.
 *
 * @module scheduled-task/compat-tools
 */

import path from 'node:path';
import { HeartbeatTaskBridge } from '../scheduled-tasks/heartbeat-task-bridge.js';
import type {
  CreateTaskRequest,
  ScheduledTask,
  TaskFilter,
} from '../scheduled-tasks/scheduled-task-types.js';
import type { OuterToolContext, ToolCallResult } from '../../outer/outer-tools.js';

// ─── 调度器管理器 ─────────────────────────────────────────────────────────

/**
 * ScheduledTaskManager — legacy wrapper around the canonical HeartbeatTaskBridge.
 */
export class ScheduledTaskManager {
  readonly scheduler: HeartbeatTaskBridge;
  private initialized = false;

  constructor(dataDir?: string) {
    this.scheduler = new HeartbeatTaskBridge({
      dataRoot: resolveLegacyDataRoot(dataDir),
    });
  }

  /**
   * 初始化并启动 bridge。
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.scheduler.start();
    this.initialized = true;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

// ─── 工具函数实现 ─────────────────────────────────────────────────────────

/**
 * 创建定时任务
 *
 * 工具名：create_scheduled_task
 */
export async function execCreateScheduledTask(
  args: {
    name?: string;
    description?: string;
    schedule_type?: string;
    cron_expression?: string;
    interval_ms?: string;
    run_at?: string;
    action_type?: string;
    action_content?: string;
    tags?: string;
  },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const manager = await ensureManager(ctx);
  if (!manager) return { replied: false, output: '定时任务模块未启用。' };

  // 参数校验
  const name = args.name?.trim();
  if (!name) {
    return { replied: false, output: '参数 name 不能为空。' };
  }

  const scheduleType = args.schedule_type?.trim() ?? 'cron';
  let request: CreateTaskRequest;

  switch (scheduleType) {
    case 'cron': {
      const expression = args.cron_expression?.trim();
      if (!expression) {
        return { replied: false, output: 'cron 模式需要提供 cron_expression 参数。' };
      }
      request = {
        name,
        description: args.description?.trim(),
        schedule: { type: 'cron', expression },
        action: { type: 'prompt', content: '' },
        createdBy: { type: 'agent', id: ctx.agentSid, name: resolveCreatorName(ctx.agentSid) },
      };
      break;
    }
    case 'interval': {
      const intervalMs = parseInt(args.interval_ms ?? '', 10);
      if (!intervalMs || intervalMs < 1000) {
        return { replied: false, output: 'interval 模式需要提供有效的 interval_ms 参数（至少 1000ms）。' };
      }
      request = {
        name,
        description: args.description?.trim(),
        schedule: { type: 'interval', intervalMs, startDelayMs: 0 },
        action: { type: 'prompt', content: '' },
        createdBy: { type: 'agent', id: ctx.agentSid, name: resolveCreatorName(ctx.agentSid) },
      };
      break;
    }
    case 'once': {
      const runAt = args.run_at?.trim();
      if (!runAt) {
        return { replied: false, output: 'once 模式需要提供 run_at 参数（ISO 8601 时间）。' };
      }
      request = {
        name,
        description: args.description?.trim(),
        schedule: { type: 'once', runAt },
        action: { type: 'prompt', content: '' },
        createdBy: { type: 'agent', id: ctx.agentSid, name: resolveCreatorName(ctx.agentSid) },
      };
      break;
    }
    default:
      return { replied: false, output: `不支持的调度类型：${scheduleType}。支持：cron / interval / once。` };
  }

  const actionType = args.action_type?.trim() ?? 'prompt';
  switch (actionType) {
    case 'prompt': {
      const content = args.action_content?.trim();
      if (!content) {
        return { replied: false, output: 'prompt 动作需要提供 action_content 参数。' };
      }
      request.action = { type: 'prompt', content, includeContext: true };
      break;
    }
    case 'tool_call': {
      const content = args.action_content?.trim();
      if (!content) {
        return { replied: false, output: 'tool_call 动作需要提供 action_content（JSON 格式的工具参数）。' };
      }
      try {
        const parsed = JSON.parse(content) as { toolName?: string; parameters?: Record<string, unknown> };
        if (!parsed.toolName) {
          return { replied: false, output: 'tool_call 动作需要 action_content 中包含 toolName 字段。' };
        }
        request.action = { type: 'tool_call', tool: parsed.toolName, params: parsed.parameters ?? {} };
      } catch {
        return { replied: false, output: 'tool_call 动作的 action_content 必须是有效 JSON。' };
      }
      break;
    }
    case 'message': {
      const content = args.action_content?.trim();
      if (!content) {
        return { replied: false, output: 'message 动作需要提供 action_content 参数。' };
      }
      request.action = { type: 'send_message', content, channel: ctx.threadId };
      break;
    }
    default:
      return { replied: false, output: `不支持的动作类型：${actionType}。支持：prompt / tool_call / message。` };
  }

  // 解析标签
  const tags = args.tags
    ? args.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  request.tags = tags;
  request.metadata = { source: 'legacy_scheduled_task_tool', threadId: ctx.threadId, agentSid: ctx.agentSid };
  request.executionConfig = {
    timeoutMs: 120_000,
    maxConsecutiveFailures: 3,
    retryCount: 1,
    retryIntervalMs: 30_000,
    onlyWhenIdle: false,
  };

  try {
    const task = await manager.scheduler.createTask(request);

    return {
      replied: false,
      output: JSON.stringify({
        success: true,
        task: {
          id: task.id,
          name: task.name,
          schedule: task.schedule,
          status: task.status,
          nextRunAt: task.nextRunAt,
        },
      }),
    };
  } catch (e) {
    return {
      replied: false,
      output: `创建任务失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 列出定时任务
 *
 * 工具名：list_scheduled_tasks
 */
export async function execListScheduledTasks(
  args: {
    status?: string;
    tags?: string;
    schedule_type?: string;
  },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const manager = await ensureManager(ctx);
  if (!manager) return { replied: false, output: '定时任务模块未启用。' };

  const filter: TaskFilter = {};
  const statuses = args.status
    ? args.status.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const tags = args.tags
    ? args.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const scheduleType = args.schedule_type?.trim() as 'cron' | 'interval' | 'once' | undefined;

  if (statuses.length === 1) filter.status = statuses[0] as ScheduledTask['status'];
  if (tags.length > 0) filter.tags = tags;
  if (scheduleType) filter.scheduleType = scheduleType;

  let tasks = await manager.scheduler.listTasks(Object.keys(filter).length > 0 ? filter : undefined);
  if (statuses.length > 1) {
    const set = new Set(statuses);
    tasks = tasks.filter((t) => set.has(t.status));
  }

  const summary = tasks.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    schedule: t.schedule,
    nextRunAt: t.nextRunAt,
    lastRunAt: t.lastRunAt,
    consecutiveFailures: t.consecutiveFailures ?? 0,
  }));

  return {
    replied: false,
    output: JSON.stringify({ success: true, count: summary.length, tasks: summary }),
  };
}

/**
 * 删除定时任务
 *
 * 工具名：delete_scheduled_task
 */
export async function execDeleteScheduledTask(
  args: {
    task_id?: string;
  },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const manager = await ensureManager(ctx);
  if (!manager) return { replied: false, output: '定时任务模块未启用。' };

  const taskId = args.task_id?.trim();
  if (!taskId) {
    return { replied: false, output: '参数 task_id 不能为空。' };
  }

  // 先检查任务是否存在
  const existing = await manager.scheduler.getTask(taskId);
  if (!existing) {
    return { replied: false, output: `找不到任务：${taskId}。` };
  }

  await manager.scheduler.deleteTask(taskId);

  return {
    replied: false,
    output: JSON.stringify({ success: true, deleted: { id: taskId, name: existing.name } }),
  };
}

/**
 * 暂停/恢复定时任务
 *
 * 工具名：toggle_scheduled_task
 */
export async function execToggleScheduledTask(
  args: {
    task_id?: string;
    active?: string;
  },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const manager = await ensureManager(ctx);
  if (!manager) return { replied: false, output: '定时任务模块未启用。' };

  const taskId = args.task_id?.trim();
  if (!taskId) {
    return { replied: false, output: '参数 task_id 不能为空。' };
  }

  const activeStr = args.active?.trim()?.toLowerCase();
  const active = activeStr !== 'false' && activeStr !== '0' && activeStr !== 'pause';

  // 检查任务是否存在
  const existing = await manager.scheduler.getTask(taskId);
  if (!existing) {
    return { replied: false, output: `找不到任务：${taskId}。` };
  }

  const updated = active
    ? await manager.scheduler.resumeTask(taskId)
    : await manager.scheduler.pauseTask(taskId);

  return {
    replied: false,
    output: JSON.stringify({
      success: true,
      task: {
        id: taskId,
        name: existing.name,
        status: active ? 'active' : 'paused',
        nextRunAt: updated?.nextRunAt,
      },
    }),
  };
}

async function ensureManager(ctx: OuterToolContext & { scheduledTaskManager?: ScheduledTaskManager }): Promise<ScheduledTaskManager | null> {
  const manager = ctx.scheduledTaskManager ?? null;
  if (!manager) return null;
  await manager.init();
  return manager;
}

function resolveCreatorName(agentSid: string): string {
  return process.env['UTLRA_AGENT_NAME']?.trim() || agentSid;
}

function resolveLegacyDataRoot(dataDir?: string): string {
  const resolved = path.resolve(dataDir ?? 'data/scheduled_tasks');
  return path.basename(resolved) === 'scheduled_tasks' ? path.dirname(resolved) : resolved;
}
