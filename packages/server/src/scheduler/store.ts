/**
 * Scheduler Module - Task Store Facade
 *
 * Re-exports the TaskStore from the scheduled-tasks implementation module
 * and provides a simplified store interface for the scheduler facade layer.
 *
 * @module scheduler/store
 */

export {
  TaskStore,
  type TaskStoreConfig,
} from '../openkuroneko/scheduled-tasks/task-store.js';