/**
 * TaskMonitor — 定时任务状态监控与执行日志查询。
 *
 * 提供任务执行历史、运行状态摘要、统计信息的查询接口。
 * 在 M3 阶段集成到心跳机制中，通过 TaskMonitorBridge 暴露给外脑。
 *
 * 核心职责：
 *   1. 查询任务执行历史（按 taskId、时间范围、状态过滤）
 *   2. 生成调度器运行摘要（活跃/暂停/失败任务数）
 *   3. 提供统计信息（成功率、平均执行时长等）
 *   4. 生成文本格式的监控报告
 */

import type {
  ScheduledTask,
  ExecutionLog,
  ExecutionStatus,
  TaskStatus,
  SchedulerState,
} from './scheduled-task-types.js';
import type { TaskStore } from './task-store.js';

// ── Public Types ────────────────────────────────────────────────────────────

/** Execution log query filter */
export interface LogQueryFilter {
  /** Filter by task ID */
  taskId?: string;
  /** Filter by execution status */
  status?: ExecutionStatus;
  /** Only logs after this timestamp (ISO 8601) */
  since?: string;
  /** Only logs before this timestamp (ISO 8601) */
  until?: string;
  /** Maximum number of logs to return, default 50 */
  limit?: number;
  /** Offset for pagination, default 0 */
  offset?: number;
}

/** Task execution statistics */
export interface TaskStatistics {
  /** Total number of executions */
  totalExecutions: number;
  /** Number of successful executions */
  successfulExecutions: number;
  /** Number of failed executions */
  failedExecutions: number;
  /** Number of timed out executions */
  timedOutExecutions: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average execution duration in ms */
  averageDurationMs: number;
  /** Maximum execution duration in ms */
  maxDurationMs: number;
  /** Minimum execution duration in ms */
  minDurationMs: number;
  /** Last execution time (ISO 8601) */
  lastExecutionAt: string | null;
  /** Last failure time (ISO 8601) */
  lastFailureAt: string | null;
}

/** Scheduler health summary */
export interface SchedulerHealthSummary {
  /** Current scheduler state */
  state: SchedulerState;
  /** Number of active tasks */
  activeTaskCount: number;
  /** Number of paused tasks */
  pausedTaskCount: number;
  /** Number of suspended tasks (auto-suspended due to consecutive failures) */
  suspendedTaskCount: number;
  /** Number of completed tasks (one-shot) */
  completedTaskCount: number;
  /** Total number of tasks */
  totalTaskCount: number;
  /** Tasks currently due for execution */
  dueTaskCount: number;
  /** Per-task health status */
  tasks: TaskHealthEntry[];
}

/** Per-task health entry */
export interface TaskHealthEntry {
  /** Task ID */
  taskId: string;
  /** Task name */
  taskName: string;
  /** Task status */
  status: TaskStatus;
  /** Schedule type */
  scheduleType: string;
  /** Next scheduled run time (ISO 8601) */
  nextRunAt: string | null;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Last execution time (ISO 8601) */
  lastExecutedAt: string | null;
  /** Last execution result */
  lastResult: string | null;
}

// ── TaskMonitor ──────────────────────────────────────────────────────────────

export class TaskMonitor {
  constructor(private readonly store: TaskStore) {}

  // ── Execution Log Queries ───────────────────────────────────────────────

  /**
   * Query execution logs with filtering and pagination.
   */
  queryLogs(filter: LogQueryFilter = {}): ExecutionLog[] {
    let logs: ExecutionLog[];

    if (filter.taskId) {
      logs = this.store.getLogs(filter.taskId);
    } else {
      logs = this.getAllLogs();
    }

    // Apply status filter
    if (filter.status) {
      logs = logs.filter(log => log.status === filter.status);
    }

    // Apply time range filter
    if (filter.since) {
      const since = new Date(filter.since).getTime();
      logs = logs.filter(log => new Date(log.startedAt).getTime() >= since);
    }
    if (filter.until) {
      const until = new Date(filter.until).getTime();
      logs = logs.filter(log => new Date(log.startedAt).getTime() <= until);
    }

    // Sort by startedAt descending (newest first)
    logs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    // Pagination
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return logs.slice(offset, offset + limit);
  }

  /**
   * Get recent execution logs across all tasks.
   */
  getRecentLogs(limit = 20): ExecutionLog[] {
    return this.queryLogs({ limit });
  }

  /**
   * Get execution logs for a specific task.
   */
  getTaskLogs(taskId: string, limit = 50): ExecutionLog[] {
    return this.queryLogs({ taskId, limit });
  }

  // ── Statistics ──────────────────────────────────────────────────────────

  /**
   * Calculate statistics for a specific task.
   */
  getTaskStatistics(taskId: string): TaskStatistics {
    const logs = this.store.getLogs(taskId);
    return this.calculateStatistics(logs);
  }

  /**
   * Calculate overall statistics across all tasks.
   */
  getOverallStatistics(): TaskStatistics {
    const allLogs = this.getAllLogs();
    return this.calculateStatistics(allLogs);
  }

  // ── Health Summary ──────────────────────────────────────────────────────

  /**
   * Generate a health summary of all scheduled tasks.
   */
  getHealthSummary(): SchedulerHealthSummary {
    const tasks = this.store.listTasks();
    const state = this.store.loadState();
    const now = Date.now();

    let activeTaskCount = 0;
    let pausedTaskCount = 0;
    let suspendedTaskCount = 0;
    let completedTaskCount = 0;
    let dueTaskCount = 0;

    const taskEntries: TaskHealthEntry[] = [];

    for (const task of tasks) {
      // Count by status
      switch (task.status) {
        case 'active':
          activeTaskCount++;
          break;
        case 'paused':
          pausedTaskCount++;
          break;
        default:
          suspendedTaskCount++;
          break;
        case 'completed':
          completedTaskCount++;
          break;
      }

      // Check if due
      if (task.status === 'active' && task.nextRunAt) {
        const nextRun = new Date(task.nextRunAt).getTime();
        if (nextRun <= now) {
          dueTaskCount++;
        }
      }

      // Get last execution info
      const taskLogs = this.store.getLogs(task.id);
      const lastLog = taskLogs.length > 0
        ? taskLogs.reduce((a, b) =>
            new Date(a.startedAt).getTime() > new Date(b.startedAt).getTime() ? a : b
          )
        : null;

      taskEntries.push({
        taskId: task.id,
        taskName: task.name,
        status: task.status,
        scheduleType: task.schedule.type,
        nextRunAt: task.nextRunAt,
        consecutiveFailures: task.consecutiveFailures ?? 0,
        lastExecutedAt: lastLog?.startedAt ?? null,
        lastResult: lastLog?.result ?? null,
      });
    }

    return {
      state,
      activeTaskCount,
      pausedTaskCount,
      suspendedTaskCount,
      completedTaskCount,
      totalTaskCount: tasks.length,
      dueTaskCount,
      tasks: taskEntries,
    };
  }

  // ── Text Report Generation ──────────────────────────────────────────────

  /**
   * Generate a human-readable monitoring report.
   */
  generateReport(): string {
    const summary = this.getHealthSummary();
    const overallStats = this.getOverallStatistics();
    const lines: string[] = [];

    lines.push('=== 定时任务监控报告 ===');
    lines.push(`生成时间: ${new Date().toISOString()}`);
    lines.push('');

    // Scheduler state
    lines.push('--- 调度器状态 ---');
    lines.push(`状态: ${summary.state.schedulerStatus}`);
    lines.push(`上次心跳: ${summary.state.lastHeartbeatAt ?? '从未运行'}`);
    lines.push(`总执行次数: ${summary.state.totalExecutions}`);
    lines.push('');

    // Task summary
    lines.push('--- 任务概览 ---');
    lines.push(`总任务数: ${summary.totalTaskCount}`);
    lines.push(`活跃: ${summary.activeTaskCount} | 暂停: ${summary.pausedTaskCount} | 已挂起: ${summary.suspendedTaskCount} | 已完成: ${summary.completedTaskCount}`);
    lines.push(`待执行: ${summary.dueTaskCount}`);
    lines.push('');

    // Statistics
    lines.push('--- 执行统计 ---');
    lines.push(`总执行: ${overallStats.totalExecutions}`);
    lines.push(`成功: ${overallStats.successfulExecutions} | 失败: ${overallStats.failedExecutions} | 超时: ${overallStats.timedOutExecutions}`);
    lines.push(`成功率: ${(overallStats.successRate * 100).toFixed(1)}%`);
    if (overallStats.totalExecutions > 0) {
      lines.push(`平均耗时: ${overallStats.averageDurationMs}ms`);
      lines.push(`最大耗时: ${overallStats.maxDurationMs}ms | 最小耗时: ${overallStats.minDurationMs}ms`);
    }
    lines.push('');

    // Per-task status
    if (summary.tasks.length > 0) {
      lines.push('--- 各任务状态 ---');
      for (const t of summary.tasks) {
        const statusEmoji = t.status === 'active' ? '[OK]' : t.status === 'paused' ? '[PAUSED]' : '[DONE]';
        lines.push(`    调度: ${t.scheduleType} | 下次执行: ${t.nextRunAt ?? '无'} | 连续失败: ${t.consecutiveFailures}`);
        if (t.lastExecutedAt) {
          const resultPreview = t.lastResult
            ? (t.lastResult.length > 60 ? t.lastResult.slice(0, 60) + '...' : t.lastResult)
            : '无结果';
          lines.push(`    上次执行: ${t.lastExecutedAt} | 结果: ${resultPreview}`);
        }
      }
    } else {
      lines.push('--- 无已注册任务 ---');
    }

    return lines.join('\n');
  }

  /**
   * Generate a compact status line for heartbeat logging.
   */
  generateStatusLine(): string {
    const summary = this.getHealthSummary();
    const parts: string[] = [];
    parts.push(`tasks=${summary.totalTaskCount}`);
    parts.push(`active=${summary.activeTaskCount}`);
    parts.push(`due=${summary.dueTaskCount}`);
    if (summary.suspendedTaskCount > 0) {
      parts.push(`suspended=${summary.suspendedTaskCount}`);
    }
    return `[scheduled-tasks] ${parts.join(' ')}`;
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  private getAllLogs(): ExecutionLog[] {
    const tasks = this.store.listTasks();
    const allLogs: ExecutionLog[] = [];
    for (const task of tasks) {
      const logs = this.store.getLogs(task.id);
      allLogs.push(...logs);
    }
    return allLogs;
  }

  private calculateStatistics(logs: ExecutionLog[]): TaskStatistics {
    if (logs.length === 0) {
      return {
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        timedOutExecutions: 0,
        successRate: 0,
        averageDurationMs: 0,
        maxDurationMs: 0,
        minDurationMs: 0,
        lastExecutionAt: null,
        lastFailureAt: null,
      };
    }

    let successful = 0;
    let failed = 0;
    let timedOut = 0;
    let totalDuration = 0;
    let maxDuration = 0;
    let minDuration = Infinity;
    let lastExecutionAt: string | null = null;
    let lastFailureAt: string | null = null;

    for (const log of logs) {
      // Duration
      if (log.finishedAt) {
        const duration = new Date(log.finishedAt).getTime() - new Date(log.startedAt).getTime();
        maxDuration = Math.max(maxDuration, duration);
        minDuration = Math.min(minDuration, duration);
      }

      // Status counts
      switch (log.status) {
        case 'success':
          successful++;
          break;
        case 'failed':
          failed++;
          if (!lastFailureAt || new Date(log.startedAt).getTime() > new Date(lastFailureAt).getTime()) {
            lastFailureAt = log.startedAt;
          }
          break;
        case 'timeout':
          timedOut++;
          if (!lastFailureAt || new Date(log.startedAt).getTime() > new Date(lastFailureAt).getTime()) {
            lastFailureAt = log.startedAt;
          }
          break;
      }

      // Track last execution time
      if (!lastExecutionAt || new Date(log.startedAt).getTime() > new Date(lastExecutionAt).getTime()) {
        lastExecutionAt = log.startedAt;
      }
    }

    const finishedLogs = logs.filter(l => l.finishedAt);
    return {
      totalExecutions: logs.length,
      successfulExecutions: successful,
      failedExecutions: failed,
      timedOutExecutions: timedOut,
      successRate: logs.length > 0 ? successful / logs.length : 0,
      averageDurationMs: finishedLogs.length > 0 ? Math.round(totalDuration / finishedLogs.length) : 0,
      maxDurationMs: maxDuration === 0 ? 0 : maxDuration,
      minDurationMs: minDuration === Infinity ? 0 : minDuration,
      lastExecutionAt,
      lastFailureAt,
    };
  }
}
