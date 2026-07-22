/**
 * Scheduler Module - Barrel Export
 *
 * Canonical public entry for the scheduled-task subsystem.
 *
 * `src/openkuroneko/scheduled-tasks/` remains the engine implementation,
 * while this module is the supported import path for application code.
 *
 * Usage:
 *   import { Scheduler, TaskExecutor, HeartbeatTaskBridge } from '../scheduler/index.js';
 *
 * @module scheduler
 */

// -- Type re-exports -----------------------------------------------------------
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
  // Scheduler status
  SchedulerStatus,
  SchedulerState,
  // Scheduler config & events
  TaskSchedulerConfig,
  SchedulerEvent,
  // Store config
  TaskStoreConfig,
  // Bridge types
  HeartbeatTaskBridgeConfig,
  HeartbeatTaskBridgeDeps,
  BridgeEventCallback,
  BridgeEvent,
  // Monitor types
  LogQueryFilter,
  TaskStatistics,
  SchedulerHealthSummary,
  TaskHealthEntry,
  // Alert types
  AlertLevel,
  AlertCategory,
  AlertNotification,
  AlertNotifier,
  ImAlertNotifierConfig,
  AlertHandlerCoreConfig,
  // Facade-layer types
  SchedulerConfig,
  ExecutorCallbacks,
} from './types.js';

// -- Core class exports -------------------------------------------------------
export { Scheduler } from './scheduler.js';
export { EmployeeCalendar } from './employee-calendar.js';
export type {
  CalendarCommitmentView,
  CalendarPurpose,
  DueCalendarCommitment,
  EmployeeCalendarPort,
  EmployeeCalendarScheduler,
  EnsurePeriodicCommitmentInput,
  ListCommitmentsFilter,
  UpsertCommitmentInput,
} from './employee-calendar.js';
export {
  CALENDAR_DUE_TOOL_CALL_ALLOWLIST,
  MAX_ACTIVE_CALENDAR_COMMITMENTS,
  MIN_CALENDAR_INTERVAL_MS,
} from './employee-calendar.js';
export { TaskExecutor as TaskExecutor } from './executor.js';
export { TaskStore } from './store.js';

// -- Bridge re-export (integration layer) -------------------------------------
export { HeartbeatTaskBridge } from '../openkuroneko/scheduled-tasks/heartbeat-task-bridge.js';
export {
  createScheduledTaskBridge,
  startScheduledTaskBridge,
  getScheduledTaskHealthStatus,
} from '../openkuroneko/scheduled-tasks/integration-entry.js';

// -- Cron utilities -----------------------------------------------------------
export {
  CronParser,
  validateCronExpression,
  describeCronExpression,
  getNextCronRun,
  parseCronExpression,
} from '../openkuroneko/scheduled-tasks/cron-parser.js';

// -- Monitor ------------------------------------------------------------------
export { TaskMonitor } from '../openkuroneko/scheduled-tasks/task-monitor.js';

// -- Alert handler ------------------------------------------------------------
export {
  AlertHandlerCore,
  ImAlertNotifier,
  ConsoleAlertNotifier,
  CallbackAlertNotifier,
} from '../openkuroneko/scheduled-tasks/alert-handler.js';
