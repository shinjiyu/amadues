/**
 * Scheduler Module - Type Definitions
 *
 * Re-exports core types from the scheduled-tasks implementation module
 * and adds adapter-layer types for the scheduler facade.
 *
 * This file serves as the public type surface of the scheduler module,
 * aligning with the design document's architecture while delegating to
 * the existing scheduled-tasks implementation.
 *
 * @module scheduler/types
 */

// -- Re-export core types from scheduled-tasks implementation ----------------
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
} from '../openkuroneko/scheduled-tasks/scheduled-task-types.js';

// -- Re-export scheduler-level types -----------------------------------------
export type {
  TaskSchedulerConfig,
  SchedulerEvent,
} from '../openkuroneko/scheduled-tasks/task-scheduler.js';

// -- Re-export store types ---------------------------------------------------
export type { TaskStoreConfig } from '../openkuroneko/scheduled-tasks/task-store.js';

// -- Re-export bridge types --------------------------------------------------
export type {
  HeartbeatTaskBridgeConfig,
  HeartbeatTaskBridgeDeps,
  BridgeEventCallback,
  BridgeEvent,
} from '../openkuroneko/scheduled-tasks/heartbeat-task-bridge.js';

// -- Re-export monitor types -------------------------------------------------
export type {
  LogQueryFilter,
  TaskStatistics,
  SchedulerHealthSummary,
  TaskHealthEntry,
} from '../openkuroneko/scheduled-tasks/task-monitor.js';

// -- Re-export alert types ---------------------------------------------------
export type {
  AlertLevel,
  AlertCategory,
  AlertNotification,
  AlertNotifier,
  ImAlertNotifierConfig,
  AlertHandlerCoreConfig,
} from '../openkuroneko/scheduled-tasks/alert-handler.js';

// -- Re-export cron parser utilities -----------------------------------------
export {
  CronParser,
  getNextCronRun,
  validateCronExpression,
  describeCronExpression,
  parseCronExpression,
} from '../openkuroneko/scheduled-tasks/cron-parser.js';

// -- Facade-layer types (defined here for the scheduler module) ---------------

/** Configuration for the Scheduler facade */
export interface SchedulerConfig {
  /** Base directory for task data persistence (contains scheduled_tasks/) */
  dataRoot: string;
  /** Maximum tasks to execute per heartbeat tick (default: 5) */
  maxExecutionsPerBeat?: number;
  /** Heartbeat interval in milliseconds (default: 300_000) */
  defaultHeartbeatMs?: number;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Preserve missed tasks as due for digitalEmployeeLoop recovery. */
  deferMissedExecution?: boolean;
}

/** Callback signatures for executor action dispatching */
export interface ExecutorCallbacks {
  /** Execute a prompt-based action (outer-brain trigger) */
  executePromptAction?: (taskId: string, prompt: string) => Promise<string>;
  /** Execute a tool-call action */
  executeToolCallAction?: (taskId: string, toolName: string, params: Record<string, unknown>) => Promise<string>;
  /** Execute a send-message action (IM push) */
  executeSendMessageAction?: (taskId: string, target: string, content: string) => Promise<string>;
  /** Check if the Agent is currently busy */
  isAgentBusy?: () => boolean;
  /** Send a notification to the user */
  notifyUser?: (taskId: string, message: string) => Promise<void>;
}