/**
 * TaskScheduler - Core heartbeat-driven task scheduler.
 *
 * Embeds into OuterHeartbeat's tick() cycle.
 * Each heartbeat calls onHeartbeat(), checking due tasks and executing serially.
 *
 * Core responsibilities:
 *   1. Task CRUD (create/query/update/delete/pause/resume)
 *   2. Heartbeat-driven scheduling (check nextRunAt <= now, sort by priority, serial execution)
 *   3. Failure retry (by retryCount config, mark timeout after expiry)
 *   4. Auto-pause on consecutive failures (consecutiveFailures >= maxConsecutiveFailures)
 *   5. Dynamic nextRunAt calculation (cron/interval/once schedule rules)
 *   6. Startup recovery (handle missed tasks during downtime)
 *
 * Design principles:
 *   - Zero concurrency risk: all operations serial within heartbeat
 *   - Persistence first: every state change written immediately
 *   - Gradual complexity: M2 core scheduling, M3 heartbeat + Agent execution
 */

import * as crypto from 'node:crypto';
import type {
  ScheduledTask,
  ScheduleRule,
  CronSchedule,
  IntervalSchedule,
  OnceSchedule,
  TaskAction,
  TaskStatus,
  ExecutionLog,
  TaskExecutionConfig,
  CreateTaskRequest,
  TaskFilter,
  SchedulerStatus,
} from './scheduled-task-types.js';
import { CronParser, validateCronExpression } from './cron-parser.js';
import { TaskStore, type TaskStoreConfig } from './task-store.js';

// ── Public Types ────────────────────────────────────────────────────────────

/** TaskScheduler configuration */
export interface TaskSchedulerConfig {
  /** Base directory for task data (contains scheduled_tasks/) */
  dataRoot: string;
  /** Maximum tasks to execute per heartbeat tick, default 5 */
  maxExecutionsPerBeat?: number;
  /** Default heartbeat interval in ms, used for missed task threshold, default 300_000 */
  defaultHeartbeatMs?: number;
  /** Callback: inject prompt into Agent execution flow */
  executePromptAction?: (taskId: string, prompt: string) => Promise<string>;
  /** Callback: invoke a tool by name */
  executeToolCallAction?: (taskId: string, toolName: string, params: Record<string, unknown>) => Promise<string>;
  /** Callback: send a message to IM */
  executeSendMessageAction?: (taskId: string, target: string, content: string) => Promise<string>;
  /** Callback: check if Agent is currently busy */
  isAgentBusy?: () => boolean;
  /** Callback: send notification to user */
  notifyUser?: (taskId: string, message: string) => Promise<void>;
  /**
   * Calendar mode: keep missed tasks due for the unified digitalEmployeeLoop
   * instead of executing or pausing them during scheduler initialization.
   */
  deferMissedExecution?: boolean;
  /** Injected TaskStore instance (optional, creates new if omitted) */
  store?: TaskStore;
}

/** Scheduler lifecycle event */
export type SchedulerEvent =
  | { type: 'task_created'; taskId: string }
  | { type: 'task_deleted'; taskId: string }
  | { type: 'task_updated'; taskId: string }
  | { type: 'task_paused'; taskId: string; reason: string }
  | { type: 'task_resumed'; taskId: string }
  | { type: 'task_executed'; taskId: string; status: ExecutionLog['status'] }
  | { type: 'task_completed'; taskId: string }
  | { type: 'heartbeat_tick'; executedCount: number }
  | { type: 'scheduler_started' }
  | { type: 'scheduler_error'; error: Error };

// ── TaskScheduler ───────────────────────────────────────────────────────────

const MISSED_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export class TaskScheduler {
  private readonly config: TaskSchedulerConfig;
  private readonly store: TaskStore;
  private readonly listeners: Array<(event: SchedulerEvent) => void> = [];
  private initialized = false;

  constructor(configOrDataRoot: string | TaskSchedulerConfig | TaskStoreConfig) {
    if (typeof configOrDataRoot === 'string') {
      this.config = { dataRoot: configOrDataRoot };
    } else {
      // TaskStoreConfig is a structural subset of TaskSchedulerConfig, so
      // preserving all supplied fields is both safe and required for options
      // such as deferMissedExecution.
      this.config = configOrDataRoot as TaskSchedulerConfig;
    }
    const cfg = this.config as TaskSchedulerConfig;
    this.store = cfg.store ?? new TaskStore(this.config.dataRoot);
  }

  /** Subscribe to scheduler events */
  onEvent(listener: (event: SchedulerEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[scheduled-tasks][scheduler] event listener error:', e);
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Initialize: load tasks from disk, recover missed tasks.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.load();
    await this.recoverMissedTasks();
    this.initialized = true;
    this.emit({ type: 'scheduler_started' });
    console.log('[scheduled-tasks][scheduler] initialized, tasks loaded:', this.store.taskCount());
  }

  /**
   * Recover tasks that were due during system downtime.
   */
  async recoverMissedTasks(): Promise<void> {
    const now = new Date();
    const tasks = this.store.getAllActive();

    for (const task of tasks) {
      if (!task.nextRunAt) continue;
      const nextRun = new Date(task.nextRunAt);
      if (nextRun <= now) {
        if (this.config.deferMissedExecution) {
          this.emit({ type: 'task_updated', taskId: task.id });
          continue;
        }
        const missedDuration = now.getTime() - nextRun.getTime();
        if (missedDuration > MISSED_THRESHOLD_MS) {
          // Missed too long, pause and notify
          task.status = 'paused';
          await this.store.save(task);
          this.emit({ type: 'task_paused', taskId: task.id, reason: 'missed_on_restart' });
          if (this.config.notifyUser) {
            await this.config.notifyUser(task.id,
              `Task "${task.name}" has been paused because it was missed during system downtime. Please resume manually.`
            );
          }
          console.log(`[scheduled-tasks][scheduler] task "${task.name}" (${task.id}) paused: missed during downtime`);
        } else {
          // Missed recently, execute immediately
          console.log(`[scheduled-tasks][scheduler] recovering missed task: "${task.name}" (${task.id})`);
          await this.executeWithRetry(task);
        }
      }
    }
  }

  /**
   * Shutdown: save current state.
   */
  async shutdown(): Promise<void> {
    await this.store.flush();
    console.log('[scheduled-tasks][scheduler] shutdown complete');
  }

  // ── Task CRUD ──────────────────────────────────────────────────────────

  /**
   * Create a new scheduled task.
   * Validates the schedule rule and computes initial nextRunAt.
   * Returns the new task ID.
   */
  async createTask(request: CreateTaskRequest): Promise<string> {
    // Validate schedule rule
    this.validateScheduleRule(request.schedule);

    // Validate action
    this.validateAction(request.action);

    const now = new Date();
    const id = crypto.randomUUID();
    const executionConfig = this.mergeExecutionConfig(request.executionConfig);

    const task: ScheduledTask = {
      id,
      name: request.name,
      description: request.description,
      schedule: request.schedule,
      action: request.action,
      status: 'active',
      metadata: request.metadata ?? {},
      createdBy: request.createdBy,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: this.calculateInitialNextRunAt(request.schedule)?.toISOString() ?? null,
      executionConfig,
      consecutiveFailures: 0,
    };

    await this.store.save(task);
    this.emit({ type: 'task_created', taskId: id });
    console.log(`[scheduled-tasks][scheduler] task created: "${task.name}" (${id}), nextRunAt: ${task.nextRunAt}`);
    return id;
  }

  /** Delete a task permanently. Returns true if deleted, false if not found. */
  async deleteTask(taskId: string): Promise<boolean> {
    const existing = this.store.get(taskId);
    if (!existing) return false;
    await this.store.remove(taskId);
    this.emit({ type: 'task_deleted', taskId });
    console.log(`[scheduled-tasks][scheduler] task deleted: ${taskId}`);
    return true;
  }

  /** Pause a task (sets status to 'paused'). Returns the updated task. */
  async pauseTask(taskId: string): Promise<ScheduledTask> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status === 'paused') return task;
    task.status = 'paused';
    task.updatedAt = new Date().toISOString();
    await this.store.save(task);
    this.emit({ type: 'task_paused', taskId, reason: 'user_action' });
    console.log(`[scheduled-tasks][scheduler] task paused: "${task.name}" (${taskId})`);
    return task;
  }

  /** Resume a paused task. Returns the updated task. */
  async resumeTask(taskId: string): Promise<ScheduledTask> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.status !== 'paused') return task;
    task.status = 'active';
    task.consecutiveFailures = 0;
    task.updatedAt = new Date().toISOString();
    task.nextRunAt = this.calculateNextRunAt(task.schedule)?.toISOString() ?? null;
    await this.store.save(task);
    this.emit({ type: 'task_resumed', taskId });
    console.log(`[scheduled-tasks][scheduler] task resumed: "${task.name}" (${taskId})`);
    return task;
  }

  /** List tasks, optionally filtered */
  async listTasks(filter?: TaskFilter): Promise<ScheduledTask[]> {
    return this.store.query(filter);
  }

  /** Get a single task by ID */
  async getTask(taskId: string): Promise<ScheduledTask | null> {
    return this.store.get(taskId) ?? null;
  }

  /**
   * Update a task's mutable fields.
   * Returns the updated task.
   */
  async updateTask(taskId: string, updates: {
    name?: string;
    description?: string;
    schedule?: ScheduleRule;
    action?: TaskAction;
    executionConfig?: Partial<TaskExecutionConfig>;
    metadata?: Record<string, unknown>;
  }): Promise<ScheduledTask> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (updates.schedule) {
      this.validateScheduleRule(updates.schedule);
      task.nextRunAt = this.calculateNextRunAt(updates.schedule)?.toISOString() ?? null;
    }
    if (updates.action) {
      this.validateAction(updates.action);
      task.action = updates.action;
    }
    if (updates.name !== undefined) task.name = updates.name;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.metadata !== undefined) task.metadata = updates.metadata;
    if (updates.executionConfig) {
      task.executionConfig = { ...task.executionConfig, ...updates.executionConfig };
    }

    task.updatedAt = new Date().toISOString();
    await this.store.save(task);
    this.emit({ type: 'task_updated', taskId: task.id });
    console.log(`[scheduled-tasks][scheduler] task updated: "${task.name}" (${taskId})`);
    return task;
  }

  /** Get execution logs for a task */
  async getExecutionLogs(taskId: string, limit?: number): Promise<ExecutionLog[]> {
    return this.store.queryLogs({ taskId, limit: limit ?? 20 });
  }

  /** Manually trigger a task execution (bypasses schedule check) */
  async triggerTask(taskId: string): Promise<ExecutionLog> {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const log = await this.executeWithRetry(task);
    return log;
  }

  /**
   * Get scheduler status snapshot.
   * Returns active/paused task counts, next due task, and last check time.
   */
  getSchedulerStatus(): SchedulerStatus {
    const allTasks = this.store.listTasks();
    const activeTasks = allTasks.filter(t => t.status === 'active');
    const pausedTasks = allTasks.filter(t => t.status === 'paused');

    // Find the next due task (earliest nextRunAt among active tasks)
    let nextDueTask: { name: string; dueAt: string } | null = null;
    for (const task of activeTasks) {
      if (!task.nextRunAt) continue;
      if (!nextDueTask || new Date(task.nextRunAt) < new Date(nextDueTask.dueAt)) {
        nextDueTask = { name: task.name, dueAt: task.nextRunAt };
      }
    }

    // Load state for lastHeartbeatAt and missed count
    const state = this.store.loadState();

    return {
      isRunning: state.schedulerStatus === 'running',
      activeTaskCount: activeTasks.length,
      pausedTaskCount: pausedTasks.length,
      nextDueTask,
      lastCheckAt: state.lastHeartbeatAt ?? null,
      missedTaskCount: 0, // Missed tasks are handled during recovery
    };
  }

  // ── Heartbeat Entry Point ──────────────────────────────────────────────

  /**
   * Main heartbeat handler. Called by HeartbeatTaskBridge.onHeartbeat().
   * Checks for due tasks and executes them serially.
   */
  async onHeartbeat(now: Date = new Date()): Promise<void> {
    if (!this.initialized) return;

    // Save state with current heartbeat time
    const state = this.store.loadState();
    state.lastHeartbeatAt = now.toISOString();
    state.schedulerStatus = 'running';
    this.store.saveState(state);

    const dueTasks = this.getDueTasks(now);
    const maxPerBeat = this.config.maxExecutionsPerBeat ?? 5;
    let executed = 0;

    for (const task of dueTasks) {
      if (executed >= maxPerBeat) break;
      if (this.shouldSkip(task, now)) continue;

      try {
        const log = await this.executeWithRetry(task);

        // For once-type tasks, mark as completed on success
        if (task.schedule.type === 'once' && log.status === 'success') {
          task.status = 'completed';
          await this.store.save(task);
          this.emit({ type: 'task_completed', taskId: task.id });
        }
      } catch (e) {
        console.error(`[scheduled-tasks][scheduler] unhandled error executing task "${task.name}":`, e);
        this.emit({ type: 'scheduler_error', error: e instanceof Error ? e : new Error(String(e)) });
      }
      executed++;
    }

    this.emit({ type: 'heartbeat_tick', executedCount: executed });
  }

  // ── Private: Scheduling Logic ──────────────────────────────────────────

  /** Get tasks where nextRunAt <= now, sorted by priority */
  private getDueTasks(now: Date): ScheduledTask[] {
    return this.store.getAllActive()
      .filter(t => t.nextRunAt && new Date(t.nextRunAt) <= now)
      .sort((a, b) => {
        const pa = (a.executionConfig.priority ?? 5);
        const pb = (b.executionConfig.priority ?? 5);
        return pa - pb; // Lower number = higher priority
      });
  }

  /** Check if a task should be skipped in this heartbeat */
  private shouldSkip(task: ScheduledTask, _now: Date): boolean {
    // Agent busy and task requires idle
    if (task.executionConfig.onlyWhenIdle && this.config.isAgentBusy?.()) {
      return true;
    }

    // Exceeded max consecutive failures -> auto-pause
    const maxFailures = task.executionConfig.maxConsecutiveFailures ?? 3;
    if (task.consecutiveFailures >= maxFailures) {
      task.status = 'paused';
      this.store.save(task);
      this.emit({ type: 'task_paused', taskId: task.id, reason: 'consecutive_failures' });
      console.warn(`[scheduled-tasks][scheduler] task "${task.name}" auto-paused: ${task.consecutiveFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  /**
   * Execute a task with retry logic.
   * On success: reset consecutiveFailures, update nextRunAt.
   * On final failure: increment consecutiveFailures.
   */
  private async executeWithRetry(task: ScheduledTask): Promise<ExecutionLog> {
    const maxAttempts = 1 + (task.executionConfig.retryCount ?? 1);
    let lastLog: ExecutionLog | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const log = this.createExecutionLog(task, attempt);

      try {
        // Wait between retries
        if (attempt > 0) {
          const retryInterval = task.executionConfig.retryIntervalMs ?? 30_000;
          await this.delay(retryInterval);
        }

        log.startedAt = new Date().toISOString();
        log.status = 'running';

        // Execute the task action with timeout
        const result = await this.executeWithTimeout(task, log);

        // Success
        log.status = 'success';
        log.finishedAt = new Date().toISOString();
        log.durationMs = new Date(log.finishedAt).getTime() - new Date(log.startedAt).getTime();
        log.result = this.truncateResult(result);

        // Reset consecutive failures
        task.consecutiveFailures = 0;
        task.lastRunAt = log.finishedAt;
        task.updatedAt = log.finishedAt;

        // Update nextRunAt for recurring tasks
        task.nextRunAt = this.calculateNextRunAt(task.schedule)?.toISOString() ?? null;

        await this.store.save(task);
        this.store.appendLog(log);
        this.emit({ type: 'task_executed', taskId: task.id, status: 'success' });

        return log;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.status = 'failed';
        log.finishedAt = new Date().toISOString();
        log.durationMs = new Date(log.finishedAt).getTime() - new Date(log.startedAt).getTime();
        log.error = errorMsg;
        log.result = undefined;

        this.store.appendLog(log);
        lastLog = log;

        if (attempt === maxAttempts - 1) {
          // Final attempt failed
          task.consecutiveFailures = (task.consecutiveFailures ?? 0) + 1;
          task.lastRunAt = log.finishedAt;
          task.updatedAt = log.finishedAt;
          task.nextRunAt = this.calculateNextRunAt(task.schedule)?.toISOString() ?? null;
          await this.store.save(task);
          this.emit({ type: 'task_executed', taskId: task.id, status: 'failed' });
          console.error(`[scheduled-tasks][scheduler] task "${task.name}" failed (attempt ${attempt + 1}/${maxAttempts}): ${errorMsg}`);
        } else {
          console.warn(`[scheduled-tasks][scheduler] task "${task.name}" attempt ${attempt + 1} failed, retrying: ${errorMsg}`);
        }
      }
    }

    return lastLog!;
  }

  /**
   * Execute a single task action with timeout.
   */
  private async executeWithTimeout(task: ScheduledTask, _log: ExecutionLog): Promise<string> {
    const timeoutMs = task.executionConfig.timeoutMs ?? 120_000;
    const action = task.action;

    return new Promise<string>(async (resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TimeoutError(`Task "${task.name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        let result: string;
        switch (action.type) {
          case 'prompt': {
            if (!this.config.executePromptAction) {
              throw new Error('No executePromptAction callback configured');
            }
            result = await this.config.executePromptAction(task.id, action.content);
            break;
          }
          case 'tool_call': {
            if (!this.config.executeToolCallAction) {
              throw new Error('No executeToolCallAction callback configured');
            }
            result = await this.config.executeToolCallAction(
              task.id,
              action.tool,
              action.params ?? {},
            );
            break;
          }
          case 'send_message': {
            if (!this.config.executeSendMessageAction) {
              throw new Error('No executeSendMessageAction callback configured');
            }
            result = await this.config.executeSendMessageAction(
              task.id,
              action.channel ?? 'default',
              action.content,
            );
            break;
          }
          default:
            throw new Error(`Unknown action type: ${(action as TaskAction).type}`);
        }
        clearTimeout(timer);
        resolve(result);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // ── Private: Validation ────────────────────────────────────────────────

  private validateScheduleRule(schedule: ScheduleRule): void {
    switch (schedule.type) {
      case 'cron': {
        const cronSchedule = schedule as CronSchedule;
        if (!cronSchedule.expression) {
          throw new Error('Cron schedule requires an expression');
        }
        const error = validateCronExpression(cronSchedule.expression);
        if (error) {
          throw new Error(`Invalid cron expression "${cronSchedule.expression}": ${error}`);
        }
        break;
      }
      case 'interval': {
        const intervalSchedule = schedule as IntervalSchedule;
        if (!intervalSchedule.intervalMs || intervalSchedule.intervalMs < 1000) {
          throw new Error('Interval schedule requires intervalMs >= 1000');
        }
        break;
      }
      case 'once': {
        const onceSchedule = schedule as OnceSchedule;
        if (!onceSchedule.runAt) {
          throw new Error('Once schedule requires a runAt timestamp');
        }
        break;
      }
      default:
        throw new Error(`Unknown schedule type: ${(schedule as ScheduleRule).type}`);
    }
  }

  private validateAction(action: TaskAction): void {
    switch (action.type) {
      case 'prompt': {
        if (!action.content) throw new Error('Prompt action requires content');
        break;
      }
      case 'tool_call': {
        if (!action.tool) throw new Error('Tool call action requires tool');
        break;
      }
      case 'send_message': {
        if (!action.channel) throw new Error('Send message action requires channel');
        if (!action.content) throw new Error('Send message action requires content');
        break;
      }
      default:
        throw new Error(`Unknown action type: ${(action as TaskAction).type}`);
    }
  }

  // ── Private: Next Run Calculation ──────────────────────────────────────

  /** Calculate initial nextRunAt for a new task */
  private calculateInitialNextRunAt(schedule: ScheduleRule): Date | undefined {
    switch (schedule.type) {
      case 'cron': {
        const next = new CronParser().getNextDate(
          (schedule as CronSchedule).expression,
          (schedule as CronSchedule).timezone,
        );
        return next ?? undefined;
      }
      case 'interval': {
        const intervalSchedule = schedule as IntervalSchedule;
        return new Date(Date.now() + (intervalSchedule.startDelayMs ?? 0) + intervalSchedule.intervalMs);
      }
      case 'once': {
        return new Date((schedule as OnceSchedule).runAt);
      }
      default:
        return undefined;
    }
  }

  /** Calculate nextRunAt for an existing task (after execution) */
  private calculateNextRunAt(schedule: ScheduleRule): Date | undefined {
    switch (schedule.type) {
      case 'cron': {
        const next = new CronParser().getNextDate(
          (schedule as CronSchedule).expression,
          (schedule as CronSchedule).timezone,
        );
        return next ?? undefined;
      }
      case 'interval': {
        return new Date(Date.now() + (schedule as IntervalSchedule).intervalMs);
      }
      case 'once': {
        // Once tasks don't repeat
        return undefined;
      }
      default:
        return undefined;
    }
  }

  // ── Private: Helpers ──────────────────────────────────────────────────

  private createExecutionLog(task: ScheduledTask, retryAttempt = 0): ExecutionLog {
    return {
      executionId: crypto.randomUUID(),
      taskId: task.id,
      startedAt: new Date().toISOString(),
      status: 'running',
      isRetry: retryAttempt > 0,
      retryAttempt,
    };
  }

  private mergeExecutionConfig(partial?: Partial<TaskExecutionConfig>): TaskExecutionConfig {
    return {
      timeoutMs: partial?.timeoutMs ?? 120_000,
      maxConsecutiveFailures: partial?.maxConsecutiveFailures ?? 3,
      retryCount: partial?.retryCount ?? 1,
      retryIntervalMs: partial?.retryIntervalMs ?? 30_000,
      onlyWhenIdle: partial?.onlyWhenIdle ?? false,
      priority: partial?.priority ?? 5,
    };
  }

  private truncateResult(result: string, maxLen = 2000): string {
    if (result.length <= maxLen) return result;
    return result.substring(0, maxLen) + '... [truncated]';
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── Helper: Timeout Error ──────────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
