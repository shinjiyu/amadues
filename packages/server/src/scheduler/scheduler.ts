/**
 * Scheduler Module - Main Scheduler Facade
 *
 * Canonical public entry for scheduled tasks.
 * It wraps `HeartbeatTaskBridge`, not bare `TaskScheduler`, so callers get:
 * - lifecycle (`start / stop / tick`)
 * - CRUD
 * - monitoring
 * - alert history
 *
 * The lower `scheduled-tasks/` directory remains the engine implementation.
 *
 * @module scheduler/scheduler
 */

import type {
  ScheduledTask,
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskFilter,
  SchedulerStatus,
  ExecutionLog,
} from '../openkuroneko/scheduled-tasks/scheduled-task-types.js';
import type { SchedulerHealthSummary } from '../openkuroneko/scheduled-tasks/task-monitor.js';
import type { AlertNotification } from '../openkuroneko/scheduled-tasks/alert-handler.js';
import {
  HeartbeatTaskBridge,
  type BridgeEventCallback,
} from '../openkuroneko/scheduled-tasks/heartbeat-task-bridge.js';
import type { SchedulerConfig, ExecutorCallbacks } from './types.js';

// -- Scheduler lifecycle states --
export type SchedulerLifecycleState = 'idle' | 'running' | 'stopped' | 'error';

/**
 * Scheduler - Facade class for the scheduled-tasks module.
 *
 * Provides a simplified lifecycle-oriented API:
 *   start() / stop() / tick()
 * Wraps the underlying HeartbeatTaskBridge from the engine layer.
 */
export class Scheduler {
  private bridge: HeartbeatTaskBridge | null = null;
  private _state: SchedulerLifecycleState = 'idle';
  private config: SchedulerConfig;
  private callbacks: ExecutorCallbacks = {};

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  /** Current lifecycle state */
  get state(): SchedulerLifecycleState {
    return this._state;
  }

  /** Whether the scheduler is currently running */
  get isRunning(): boolean {
    return this._state === 'running';
  }

  /**
   * Configure action execution callbacks.
   * Must be called before start() or between ticks.
   */
  configureCallbacks(callbacks: ExecutorCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
    if (this.bridge && this.config.verbose) {
      console.warn('[scheduler] callbacks updated after start; restart to apply new deps');
    }
  }

  /**
   * Start the scheduler.
   * Initializes the underlying HeartbeatTaskBridge with the configured dataRoot.
   */
  async start(): Promise<void> {
    if (this._state === 'running') {
      return;
    }

    try {
      this.bridge = new HeartbeatTaskBridge({
        dataRoot: this.config.dataRoot,
        maxExecutionsPerBeat: this.config.maxExecutionsPerBeat,
        defaultHeartbeatMs: this.config.defaultHeartbeatMs,
      }, {
        executePromptAction: this.callbacks.executePromptAction,
        executeToolCallAction: this.callbacks.executeToolCallAction,
        executeSendMessageAction: this.callbacks.executeSendMessageAction,
        isAgentBusy: this.callbacks.isAgentBusy,
        notifyUser: this.callbacks.notifyUser,
      });
      await this.bridge.start();

      this._state = 'running';
      console.log('[scheduler] started, dataRoot:', this.config.dataRoot);
    } catch (err) {
      this._state = 'error';
      console.error(
        '[scheduler] start failed:',
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * Stop the scheduler gracefully.
   */
  async stop(): Promise<void> {
    if (this._state !== 'running') {
      return;
    }

    if (this.bridge) {
      await this.bridge.stop();
    }
    this.bridge = null;
    this._state = 'stopped';
    console.log('[scheduler] stopped');
  }

  /**
   * Execute one heartbeat tick.
   * Checks for due tasks and executes them serially.
   * Returns the number of tasks executed.
   */
  async tick(): Promise<number> {
    this.ensureRunning();
    let executedCount = 0;
    const listener: BridgeEventCallback = (event) => {
      if (event.type === 'heartbeat_tick') {
        executedCount = event.executedCount;
      }
    };
    this.bridge!.onEvent(listener);
    try {
      await this.bridge!.onHeartbeat();
    } finally {
      this.bridge!.offEvent(listener);
    }

    if (this.config.verbose) {
      console.log('[scheduler] tick completed, executed:', executedCount);
    }

    return executedCount;
  }

  // -- Task CRUD delegated to TaskScheduler -----------------------------------

  /** Create a new scheduled task */
  async createTask(request: CreateTaskRequest): Promise<string> {
    this.ensureRunning();
    const task = await this.bridge!.createTask(request);
    return task.id;
  }

  /** Delete a task */
  async deleteTask(taskId: string): Promise<boolean> {
    this.ensureRunning();
    return this.bridge!.deleteTask(taskId);
  }

  /** Update a task */
  async updateTask(taskId: string, request: UpdateTaskRequest): Promise<ScheduledTask> {
    this.ensureRunning();
    return this.bridge!.updateTask(taskId, request);
  }

  /** Pause a task */
  async pauseTask(taskId: string): Promise<ScheduledTask> {
    this.ensureRunning();
    return this.bridge!.pauseTask(taskId);
  }

  /** Resume a paused task */
  async resumeTask(taskId: string): Promise<ScheduledTask> {
    this.ensureRunning();
    return this.bridge!.resumeTask(taskId);
  }

  /** List tasks with optional filter */
  async listTasks(filter?: TaskFilter): Promise<ScheduledTask[]> {
    this.ensureRunning();
    return this.bridge!.listTasks(filter);
  }

  /** Run a task immediately, bypassing schedule check. */
  async triggerTask(taskId: string): Promise<ExecutionLog> {
    this.ensureRunning();
    return this.bridge!.triggerTask(taskId);
  }

  /** Get per-task history. */
  getTaskHistory(taskId: string, limit?: number): ExecutionLog[] {
    this.ensureRunning();
    return this.bridge!.getTaskHistory(taskId, limit);
  }

  /** Get scheduler health summary. */
  getHealthSummary(): SchedulerHealthSummary {
    this.ensureRunning();
    return this.bridge!.getHealthSummary();
  }

  /** Get recent alert history. */
  getAlertHistory(limit?: number): AlertNotification[] {
    this.ensureRunning();
    return this.bridge!.getAlertHistory(limit);
  }

  /** Subscribe to bridge events. */
  onEvent(callback: BridgeEventCallback): void {
    this.ensureRunning();
    this.bridge!.onEvent(callback);
  }

  /** Unsubscribe from bridge events. */
  offEvent(callback: BridgeEventCallback): void {
    this.ensureRunning();
    this.bridge!.offEvent(callback);
  }

  /** Get scheduler status */
  getSchedulerStatus(): SchedulerStatus {
    if (!this.bridge) {
      return {
        isRunning: false,
        activeTaskCount: 0,
        pausedTaskCount: 0,
        nextDueTask: null,
        lastCheckAt: null,
        missedTaskCount: 0,
      };
    }
    const status = this.bridge.getSchedulerStatus();
    return {
      ...status,
      // Facade 语义：start() 成功后即视为运行中，不暴露底层“尚未收到首个 heartbeat 仍为 idle”的细节。
      isRunning: this._state === 'running' || status.isRunning,
    };
  }

  private ensureRunning(): void {
    if (!this.bridge || this._state !== 'running') {
      throw new Error('[scheduler] not running. Call start() first.');
    }
  }
}