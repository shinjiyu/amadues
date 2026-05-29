/**
 * Scheduled Tasks Module — barrel export.
 *
 * Internal engine layer for scheduled tasks.
 * New production imports should prefer `src/scheduler/index.ts`, which is the
 * canonical public facade for this subsystem.
 *
 * Provides the core scheduling infrastructure for Kuroneko/Shiro:
 *   - Type definitions for tasks, schedules, actions, execution logs
 *   - Cron expression parser (zero external dependencies)
 *   - JSON file-backed task & log persistence (TaskStore)
 *   - Heartbeat-driven task scheduler with retry & failure handling (TaskScheduler)
 *   - Heartbeat integration bridge (HeartbeatTaskBridge)
 *   - Task status monitoring and statistics (TaskMonitor)
 *   - Alert handling and notification (AlertHandlerCore, AlertNotifier)
 *
 * Runtime integration point: `HeartbeatTaskBridge.onHeartbeat()` is called from
 * `OuterHeartbeat.tick()` on every heartbeat cycle.
 *
 * @module scheduled-tasks
 */

// ── Type exports ──────────────────────────────────────────────────────────────

export type {
  // Schedule rules
  CronSchedule,
  IntervalSchedule,
  OnceSchedule,
  ScheduleRule,

  // Task actions
  PromptAction,
  ToolCallAction,
  SendMessageAction,
  TaskAction,

  // Task core
  TaskStatus,
  ScheduledTask,
  TaskExecutionConfig,
  CreatorType,
  TaskCreator,
  TaskMetadata,

  // Execution
  ExecutionStatus,
  ExecutionLog,

  // CRUD requests & filter
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskFilter,

  // Scheduler state & status
  SchedulerState,
  SchedulerStatus,
} from './scheduled-task-types.js';

// ── Cron parser ───────────────────────────────────────────────────────────────

export {
  CronParser,
  parseCronExpression,
  getNextCronRun,
  validateCronExpression,
  describeCronExpression,
} from './cron-parser.js';

// ── Task persistence ──────────────────────────────────────────────────────────

export type { TaskStoreConfig } from './task-store.js';
export { TaskStore } from './task-store.js';

// ── Task scheduler ────────────────────────────────────────────────────────────

export type { TaskSchedulerConfig, SchedulerEvent } from './task-scheduler.js';
export { TaskScheduler } from './task-scheduler.js';

// ── Heartbeat bridge ──────────────────────────────────────────────────────────

export type {
  HeartbeatTaskBridgeConfig,
  HeartbeatTaskBridgeDeps,
  BridgeEventCallback,
  BridgeEvent,
} from './heartbeat-task-bridge.js';
export { HeartbeatTaskBridge } from './heartbeat-task-bridge.js';

// ── Task monitoring ───────────────────────────────────────────────────────────

export type {
  LogQueryFilter,
  TaskStatistics,
  SchedulerHealthSummary,
  TaskHealthEntry,
} from './task-monitor.js';
export { TaskMonitor } from './task-monitor.js';

// ── Alert handling ────────────────────────────────────────────────────────────

export type {
  AlertLevel,
  AlertNotification,
  AlertCategory,
  AlertNotifier,
  ImAlertNotifierConfig,
  AlertHandlerCoreConfig,
} from './alert-handler.js';
export {
  AlertHandlerCore,
  ImAlertNotifier,
  ConsoleAlertNotifier,
  CallbackAlertNotifier,
} from './alert-handler.js';

// ── Integration entry (OuterHeartbeat adapter) ────────────────────────────────

export type {
  ScheduledTaskIntegrationConfig,
} from './integration-entry.js';
export {
  createScheduledTaskBridge,
  startScheduledTaskBridge,
  getScheduledTaskHealthStatus,
} from './integration-entry.js';
