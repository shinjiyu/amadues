/**
 * Legacy compatibility barrel for the old `openkuroneko/scheduled-task` path.
 *
 * Canonical module split:
 * - `src/openkuroneko/scheduled-tasks/` → engine implementation
 * - `src/scheduler/` → public facade
 *
 * Keep this barrel only as migration glue; new code should import from
 * `src/scheduler/` directly.
 */

export type * from './types.js';
export { JsonTaskStore } from './store.js';
export type { JsonTaskStoreOptions } from './store.js';
export { TaskScheduler } from './scheduler.js';
export type { TaskSchedulerOptions } from './scheduler.js';
export { TaskHandler } from './handler.js';
export type { TaskHandlerOptions, ExecuteCallback } from './handler.js';
