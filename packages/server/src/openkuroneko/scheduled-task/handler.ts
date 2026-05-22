/**
 * Legacy compatibility layer for the old task handler path.
 *
 * Canonical executor now lives in `src/scheduler/executor.ts`.
 */

export {
  TaskExecutor as TaskHandler,
  type TaskExecutorConfig as TaskHandlerOptions,
  type ExecutionResult as TaskActionResult,
} from '../../scheduler/executor.js';

/**
 * @deprecated Old callback shape kept only for migration readability.
 * The canonical executor model is callback-based dispatch in `TaskExecutor`.
 */
export type ExecuteCallback = (
  prompt: string,
  task: import('./types.js').ScheduledTask,
) => Promise<{ success: boolean; message: string }>;
