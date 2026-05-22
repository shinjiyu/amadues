/**
 * Legacy compatibility layer for the old scheduler path.
 *
 * Canonical public facade now lives in `src/scheduler/scheduler.ts`.
 */

export {
  Scheduler as TaskScheduler,
  type SchedulerLifecycleState,
} from '../../scheduler/scheduler.js';

export type { SchedulerConfig as TaskSchedulerOptions } from '../../scheduler/types.js';
