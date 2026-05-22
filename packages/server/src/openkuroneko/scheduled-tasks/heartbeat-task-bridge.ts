/**
 * HeartbeatTaskBridge - Facade integrating scheduler + monitor + alerts for heartbeat.
 *
 * Engine-level facade. New application code should normally import the
 * subsystem through `src/scheduler/index.ts`, which re-exports this class as
 * part of the canonical public surface.
 *
 * Embeds TaskScheduler into OuterHeartbeat's tick() cycle,
 * checking and executing due tasks on each heartbeat.
 *
 * Integration (non-invasive):
 *   OuterHeartbeat._tick() -> bridge.onHeartbeat() -> TaskScheduler.onHeartbeat()
 *
 * Bridge responsibilities:
 *   1. Forward heartbeat cycles to TaskScheduler
 *   2. Provide Agent capabilities during task execution (prompt injection, tool calls, messaging)
 *   3. Forward task execution events to monitoring and alert modules
 *
 * M2 Fixes Applied:
 *   - wireUpEvents: Added SchedulerEvent -> BridgeEvent conversion layer
 *   - handleSchedulerEvent: Fixed type from BridgeEvent to SchedulerEvent
 *   - Replaced non-existent alertHandler.onTaskFailure -> notifyTaskFailed
 *   - Replaced non-existent alertHandler.onTaskSuspended -> notifyTaskSuspended
 *   - Replaced non-existent alertHandler.onTaskTimeout -> notifyTaskTimeout
 *   - Replaced non-existent alertHandler.onAlert -> alertHandler.dispatch
 *   - Added handling for task_updated, task_completed, scheduler_error (SchedulerEvent-only types)
 *   - All alertHandler calls now fetch task object for correct signatures
 *
 * @module scheduled-tasks
 */

import type {
  ScheduledTask,
  ExecutionLog,
  CreateTaskRequest,
  TaskFilter,
  UpdateTaskRequest,
  SchedulerStatus,
} from './scheduled-task-types.js';
import { TaskScheduler, type TaskSchedulerConfig, type SchedulerEvent } from './task-scheduler.js';
import { TaskStore } from './task-store.js';
import { TaskMonitor } from './task-monitor.js';
import { AlertHandlerCore, type AlertHandlerCoreConfig } from './alert-handler.js';

// -- Bridge Configuration ---------------------------------------------------

/** HeartbeatTaskBridge configuration */
export interface HeartbeatTaskBridgeConfig {
  /** Base directory for task data (contains scheduled_tasks/) */
  dataRoot: string;
  /** Maximum tasks to execute per heartbeat tick, default 5 */
  maxExecutionsPerBeat?: number;
  /** Default heartbeat interval in ms, default 300_000 */
  defaultHeartbeatMs?: number;
  /** Alert handler configuration (optional) */
  alertConfig?: Partial<AlertHandlerCoreConfig>;
}

/** Dependencies injected from the outer heartbeat context */
export interface HeartbeatTaskBridgeDeps {
  /** Execute a prompt action for a scheduled task */
  executePromptAction?: (taskId: string, prompt: string) => Promise<string>;
  /** Execute a tool call action for a scheduled task */
  executeToolCallAction?: (taskId: string, toolName: string, params: Record<string, unknown>) => Promise<string>;
  /** Execute a send-message action for a scheduled task */
  executeSendMessageAction?: (taskId: string, conversationId: string, message: string) => Promise<string>;
  /** Notify user via IM or other channel */
  notifyUser?: (taskId: string, message: string) => Promise<void>;
  /** Check if agent is currently busy (for onlyWhenIdle tasks) */
  isAgentBusy?: () => boolean;
}

/** Bridge event callback */
export type BridgeEventCallback = (event: BridgeEvent) => void;

/** Union type for all bridge events */
export type BridgeEvent =
  | { type: 'task_created'; taskId: string }
  | { type: 'task_deleted'; taskId: string }
  | { type: 'task_executed'; taskId: string; log: ExecutionLog }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'task_paused'; taskId: string; reason?: string }
  | { type: 'task_resumed'; taskId: string }
  | { type: 'scheduler_started' }
  | { type: 'heartbeat_tick'; executedCount: number }
  | { type: 'task_completed'; taskId: string }
  | { type: 'task_updated'; taskId: string }
  | { type: 'scheduler_error'; error: string }

/**
 * HeartbeatTaskBridge — unified engine facade for the scheduled-task subsystem.
 *
 * Wraps TaskScheduler, TaskMonitor, and AlertHandlerCore behind a single API.
 * All CRUD, monitoring, and alerting go through this bridge.
 */
export class HeartbeatTaskBridge {
  private readonly scheduler: TaskScheduler;
  private readonly monitor: TaskMonitor;
  private readonly alertHandler: AlertHandlerCore;
  private readonly store: TaskStore;
  private readonly eventListeners: BridgeEventCallback[] = [];
  private started = false;

  constructor(config: HeartbeatTaskBridgeConfig, deps: HeartbeatTaskBridgeDeps = {}) {
    // Create shared store
    this.store = new TaskStore(config.dataRoot);

    // Create scheduler with injected deps
    const schedulerConfig: TaskSchedulerConfig = {
      dataRoot: config.dataRoot,
      maxExecutionsPerBeat: config.maxExecutionsPerBeat,
      defaultHeartbeatMs: config.defaultHeartbeatMs,
      executePromptAction: deps.executePromptAction,
      executeToolCallAction: deps.executeToolCallAction,
      executeSendMessageAction: deps.executeSendMessageAction,
      notifyUser: deps.notifyUser,
      isAgentBusy: deps.isAgentBusy,
    };
    this.scheduler = new TaskScheduler({ ...schedulerConfig, store: this.store });

    // Create monitor
    this.monitor = new TaskMonitor(this.store);

    // Create alert handler
    this.alertHandler = new AlertHandlerCore(config.alertConfig);
  }

  // -- Lifecycle ---------------------------------------------------------------

  /**
   * Start the bridge: initialize scheduler, wire up events.
   * Must be called before onHeartbeat().
   */
  async start(): Promise<void> {
    await this.scheduler.initialize();
    this.wireUpEvents();
    this.started = true;
    console.log('[scheduled-tasks][bridge] started');
  }

  /**
   * Stop the bridge: shutdown scheduler.
   */
  async stop(): Promise<void> {
    await this.scheduler.shutdown();
    this.started = false;
    console.log('[scheduled-tasks][bridge] stopped');
  }

  /**
   * Called on every OuterHeartbeat tick.
   * Delegates to TaskScheduler.onHeartbeat() for due-task checking and execution.
   */
  async onHeartbeat(): Promise<void> {
    if (!this.started) return;
    await this.scheduler.onHeartbeat();
  }

  // -- Task CRUD (async, delegate to scheduler) --------------------------------

  /**
   * Create a new scheduled task.
   * Returns the full ScheduledTask object.
   */
  async createTask(request: CreateTaskRequest): Promise<ScheduledTask> {
    const taskId = await this.scheduler.createTask(request);
    const task = await this.scheduler.getTask(taskId);
    return task!;
  }

  /**
   * Get a task by ID.
   */
  async getTask(taskId: string): Promise<ScheduledTask | null> {
    return this.scheduler.getTask(taskId);
  }

  /**
   * List all tasks, optionally filtered.
   */
  async listTasks(filter?: TaskFilter): Promise<ScheduledTask[]> {
    return this.scheduler.listTasks(filter);
  }

  /**
   * Update a task's properties.
   * Returns the updated task.
   */
  async updateTask(taskId: string, updates: UpdateTaskRequest): Promise<ScheduledTask> {
    await this.scheduler.updateTask(taskId, updates);
    const task = await this.scheduler.getTask(taskId);
    return task!;
  }

  /**
   * Delete a task permanently.
   * Returns true if deleted, false if not found.
   */
  async deleteTask(taskId: string): Promise<boolean> {
    try {
      const task = await this.scheduler.getTask(taskId);
      if (!task) return false;
      await this.scheduler.deleteTask(taskId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pause a task.
   * Returns the paused task.
   */
  async pauseTask(taskId: string): Promise<ScheduledTask> {
    await this.scheduler.pauseTask(taskId);
    const task = await this.scheduler.getTask(taskId);
    return task!;
  }

  /**
   * Resume a paused task.
   * Returns the resumed task.
   */
  async resumeTask(taskId: string): Promise<ScheduledTask> {
    await this.scheduler.resumeTask(taskId);
    const task = await this.scheduler.getTask(taskId);
    return task!;
  }

  /**
   * Manually trigger a task execution.
   */
  async triggerTask(taskId: string): Promise<ExecutionLog> {
    return this.scheduler.triggerTask(taskId);
  }

  // -- Monitoring (sync, delegate to monitor) ----------------------------------

  /**
   * Get execution history for a specific task.
   * Delegates to TaskMonitor.getTaskLogs() (sync).
   */
  getTaskHistory(taskId: string, limit?: number): ExecutionLog[] {
    return this.monitor.getTaskLogs(taskId, limit);
  }

  /**
   * Get scheduler health summary.
   * Delegates to TaskMonitor.getHealthSummary() (sync).
   */
  getHealthSummary(): import('./task-monitor.js').SchedulerHealthSummary {
    return this.monitor.getHealthSummary();
  }

  /**
   * Get full monitoring report as text.
   */
  getMonitoringReport(): string {
    return this.monitor.generateReport();
  }

  /**
   * Get scheduler status snapshot.
   * Delegates to TaskScheduler.getSchedulerStatus() (sync).
   */
  getSchedulerStatus(): SchedulerStatus {
    return this.scheduler.getSchedulerStatus();
  }

  // -- Alerts (sync, delegate to alert handler) --------------------------------

  /**
   * Get recent alert history.
   * Delegates to AlertHandlerCore.getAlertHistory() (sync).
   */
  getAlertHistory(limit?: number): import('./alert-handler.js').AlertNotification[] {
    return this.alertHandler.getAlertHistory(limit);
  }

  // -- Events ------------------------------------------------------------------

  /**
   * Register an event listener for bridge events.
   */
  onEvent(callback: BridgeEventCallback): void {
    this.eventListeners.push(callback);
  }

  /**
   * Remove an event listener.
   */
  offEvent(callback: BridgeEventCallback): void {
    const idx = this.eventListeners.indexOf(callback);
    if (idx >= 0) this.eventListeners.splice(idx, 1);
  }

  // -- Private: Wire up scheduler events to alerts and bridge listeners --------

  /**
   * Convert a SchedulerEvent (from TaskScheduler) to a BridgeEvent.
   * SchedulerEvent has types: task_created, task_deleted, task_updated, task_paused,
   *   task_resumed, task_executed, task_completed, heartbeat_tick, scheduler_started, scheduler_error
   * BridgeEvent has types:  task_created, task_deleted, task_executed (with log), task_failed,
   *   task_paused, task_resumed, scheduler_started, heartbeat_tick
   *
   * Conversion rules:
   *   - task_executed with status='failure' -> BridgeEvent task_failed
   *   - task_updated, task_completed, scheduler_error -> no BridgeEvent equivalent (logged only)
   *   - Others map 1:1 (with field adjustments)
   */
  private convertSchedulerEventToBridgeEvent(event: SchedulerEvent): BridgeEvent | null {
    switch (event.type) {
      case 'task_created':
        return { type: 'task_created', taskId: event.taskId };
      case 'task_deleted':
        return { type: 'task_deleted', taskId: event.taskId };
      case 'task_paused':
        return { type: 'task_paused', taskId: event.taskId, reason: event.reason };
      case 'task_resumed':
        return { type: 'task_resumed', taskId: event.taskId };
      case 'scheduler_started':
        return { type: 'scheduler_started' };
      case 'heartbeat_tick':
        return { type: 'heartbeat_tick', executedCount: event.executedCount };
      case 'task_executed': {
        // SchedulerEvent task_executed has { taskId, status } but no log
        // We cannot fabricate an ExecutionLog, so we only forward if we can find one.
        // For now, we emit a task_failed BridgeEvent if status indicates failure,
        // otherwise we skip (the log is recorded separately by the monitor).
        if (event.status === 'failed') {
          return { type: 'task_failed', taskId: event.taskId, error: 'Task execution failed' };
        }
        // Successful task_executed from SchedulerEvent — emit with a placeholder log
        // since the actual log is stored by the scheduler internally.
        return null; // Monitor will have the actual log via its own tracking
      }
      // Map to newly added BridgeEvent variants (M2 Fix: P2-2)
      case 'task_completed':
        return { type: 'task_completed', taskId: event.taskId };
      case 'task_updated':
        return { type: 'task_updated', taskId: event.taskId };
      case 'scheduler_error':
        return { type: 'scheduler_error', error: event.error.message };
      default:
        return null;
    }
  }

  private wireUpEvents(): void {
    this.scheduler.onEvent((event: SchedulerEvent) => {
      // Convert SchedulerEvent -> BridgeEvent and forward to bridge listeners
      const bridgeEvent = this.convertSchedulerEventToBridgeEvent(event);
      if (bridgeEvent) {
        this.emitEvent(bridgeEvent);
      }

      // Forward to alert handler (uses original SchedulerEvent)
      this.handleSchedulerEvent(event);
    });
  }

  /**
   * Handle SchedulerEvent by dispatching appropriate alerts via AlertHandlerCore.
   *
   * FIX (M2): All alert method calls now use actual AlertHandlerCore method names:
   *   - onTaskFailure  -> notifyTaskFailed(task, log, consecutiveCount)
   *   - onTaskSuspended -> notifyTaskSuspended(task)
   *   - onTaskTimeout  -> notifyTaskTimeout(task, log)
   *   - onAlert        -> dispatch({ level, category, ... })
   *
   * Since alert methods need ScheduledTask objects, we fetch them asynchronously.
   */
  private handleSchedulerEvent(event: SchedulerEvent): void {
    switch (event.type) {
      case 'task_executed': {
        if (event.status === 'failed') {
          // Fetch the task to pass to alertHandler.notifyTaskFailed
          this.handleTaskExecutionFailure(event.taskId);
        }
        break;
      }
      case 'task_paused': {
        // Fetch task and call notifyTaskSuspended
        this.handleTaskSuspended(event.taskId);
        break;
      }
      case 'task_created': {
        this.alertHandler.dispatch({
          level: 'info',
          category: 'heartbeat_integration',
          title: 'Task created',
          message: `Task created: ${event.taskId}`,
          taskId: event.taskId,
        }).catch(e => console.error('[scheduled-tasks][bridge] alert dispatch error:', e));
        break;
      }
      case 'task_deleted': {
        this.alertHandler.dispatch({
          level: 'info',
          category: 'heartbeat_integration',
          title: 'Task deleted',
          message: `Task deleted: ${event.taskId}`,
          taskId: event.taskId,
        }).catch(e => console.error('[scheduled-tasks][bridge] alert dispatch error:', e));
        break;
      }
      case 'task_resumed': {
        this.alertHandler.dispatch({
          level: 'info',
          category: 'task_resumed',
          title: 'Task resumed',
          message: `Task resumed: ${event.taskId}`,
          taskId: event.taskId,
        }).catch(e => console.error('[scheduled-tasks][bridge] alert dispatch error:', e));
        break;
      }
      case 'task_updated': {
        // No alert needed for task updates (internal operation)
        break;
      }
      case 'task_completed': {
        this.alertHandler.dispatch({
          level: 'info',
          category: 'heartbeat_integration',
          title: 'Task completed',
          message: `Task completed: ${event.taskId}`,
          taskId: event.taskId,
        }).catch(e => console.error('[scheduled-tasks][bridge] alert dispatch error:', e));
        break;
      }
      case 'scheduler_error': {
        this.alertHandler.notifySchedulerError(event.error).catch(e =>
          console.error('[scheduled-tasks][bridge] scheduler error alert failed:', e),
        );
        break;
      }
      case 'scheduler_started': {
        console.log('[scheduled-tasks][bridge] scheduler started event received');
        break;
      }
      case 'heartbeat_tick': {
        // Internal tick event, no action needed at bridge level
        break;
      }
    }
  }

  /**
   * Async handler for task execution failure alerts.
   * Fetches the task object needed by AlertHandlerCore.notifyTaskFailed().
   */
  private async handleTaskExecutionFailure(taskId: string): Promise<void> {
    try {
      const task = await this.scheduler.getTask(taskId);
      if (!task) return;

      // Get the latest execution log from the monitor
      const logs = this.monitor.getTaskLogs(taskId, 1);
      const lastLog = logs.length > 0 ? logs[0] : {
        executionId: 'unknown',
        taskId,
        status: 'failed' as const,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: 'Unknown error',
        isRetry: false,
        retryAttempt: 0,
      };

      await this.alertHandler.notifyTaskFailed(
        task,
        lastLog,
        task.consecutiveFailures ?? 0,
      );
    } catch (e) {
      console.error('[scheduled-tasks][bridge] failed to handle task execution failure alert:', e);
    }
  }

  /**
   * Async handler for task suspended alerts.
   * Fetches the task object needed by AlertHandlerCore.notifyTaskSuspended().
   */
  private async handleTaskSuspended(taskId: string): Promise<void> {
    try {
      const task = await this.scheduler.getTask(taskId);
      if (!task) return;

      await this.alertHandler.notifyTaskSuspended(task);
    } catch (e) {
      console.error('[scheduled-tasks][bridge] failed to handle task suspended alert:', e);
    }
  }

  private emitEvent(event: BridgeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('[scheduled-tasks][bridge] event listener error:', e);
      }
    }
  }

  // -- Direct access (for advanced usage) -----------------------------------

  /** Get the underlying TaskScheduler instance */
  getScheduler(): TaskScheduler {
    return this.scheduler;
  }

  /** Get the underlying TaskMonitor instance */
  getMonitor(): TaskMonitor {
    return this.monitor;
  }

  /** Get the underlying AlertHandlerCore instance */
  getAlertHandler(): AlertHandlerCore {
    return this.alertHandler;
  }
}
