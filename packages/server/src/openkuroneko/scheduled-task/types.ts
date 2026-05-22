/**
 * Legacy compatibility types for the old `openkuroneko/scheduled-task` path.
 *
 * Canonical public API now lives under `src/scheduler/`, backed by
 * `src/openkuroneko/scheduled-tasks/`.
 *
 * Keep this file as a thin type shim so old imports remain readable while
 * the codebase converges to the new module layout.
 */

export type {
  CronSchedule,
  IntervalSchedule,
  ScheduleRule,
  PromptAction,
  ToolCallAction,
  SendMessageAction as MessageAction,
  TaskAction,
  TaskStatus,
  ScheduledTask,
  TaskExecutionConfig as ExecutionConfig,
  TaskCreator,
  TaskMetadata,
  ExecutionLog,
  TaskFilter,
  SchedulerStatus,
  SchedulerState,
  CreateTaskRequest as CreateTaskParams,
} from '../../scheduler/types.js';

export type { OnceSchedule as OneTimeSchedule } from '../../scheduler/types.js';

/** @deprecated Use `ScheduleRule` from `src/scheduler/types.ts`. */
export type TaskSchedule = import('../../scheduler/types.js').ScheduleRule;

/** @deprecated Use `ExecutionResult` / callback return values in `src/scheduler/executor.ts`. */
export interface TaskActionResult {
  success: boolean;
  message: string;
}

/** @deprecated Old abstraction no longer used; kept for migration readability. */
export interface ITaskStore {
  loadAll(): Promise<import('../../scheduler/types.js').ScheduledTask[]>;
  save(task: import('../../scheduler/types.js').ScheduledTask): Promise<void> | void;
  delete(taskId: string): Promise<boolean> | boolean;
  saveBatch(tasks: import('../../scheduler/types.js').ScheduledTask[]): Promise<void> | void;
}

/** @deprecated Legacy interface name; prefer `Scheduler` or `HeartbeatTaskBridge`. */
export interface ITaskScheduler {
  init(): Promise<void>;
  listTasks(
    filter?: import('../../scheduler/types.js').TaskFilter,
  ): Promise<import('../../scheduler/types.js').ScheduledTask[]> | import('../../scheduler/types.js').ScheduledTask[];
}

/** @deprecated Legacy interface name; prefer `TaskExecutor`. */
export interface ITaskExecutor {
  execute(
    task: import('../../scheduler/types.js').ScheduledTask,
  ): Promise<import('../../scheduler/types.js').ExecutionLog | TaskActionResult>;
}
