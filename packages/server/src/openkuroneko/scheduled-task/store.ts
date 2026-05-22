/**
 * Legacy compatibility store for the old `openkuroneko/scheduled-task` path.
 *
 * Canonical storage now lives in `scheduled-tasks/task-store.ts`, which persists
 * under `<dataRoot>/scheduled_tasks/`. This wrapper keeps the old class names so
 * older imports remain understandable during migration.
 */

import path from 'node:path';
import { TaskStore } from '../scheduled-tasks/task-store.js';
import type {
  ScheduledTask,
  TaskFilter,
  TaskSchedule,
  TaskAction,
  TaskCreator,
  ExecutionConfig,
} from './types.js';

export interface JsonTaskStoreOptions {
  /** Legacy option: concrete task dir, e.g. `data/scheduled_tasks`. */
  dataDir?: string;
}

/** @deprecated Prefer `TaskStore` from `src/scheduler/store.ts`. */
export class JsonTaskStore {
  private readonly store: TaskStore;

  constructor(options: JsonTaskStoreOptions = {}) {
    this.store = new TaskStore(resolveLegacyDataRoot(options.dataDir));
  }

  async init(): Promise<void> {
    await this.store.load();
  }

  async loadAll(): Promise<ScheduledTask[]> {
    await this.store.load();
    return this.getAll();
  }

  getAll(): ScheduledTask[] {
    return this.store.listAll() as ScheduledTask[];
  }

  getById(taskId: string): ScheduledTask | undefined {
    return this.store.get(taskId) as ScheduledTask | undefined;
  }

  list(filter?: TaskFilter): ScheduledTask[] {
    return this.store.query(filter) as ScheduledTask[];
  }

  filter(predicate: (task: ScheduledTask) => boolean): ScheduledTask[] {
    return this.getAll().filter(predicate);
  }

  async save(task: ScheduledTask): Promise<void> {
    this.store.save(task);
  }

  async saveBatch(tasks: ScheduledTask[]): Promise<void> {
    for (const task of tasks) {
      this.store.save(task);
    }
  }

  async delete(taskId: string): Promise<boolean> {
    const existed = !!this.store.get(taskId);
    if (existed) {
      this.store.remove(taskId);
    }
    return existed;
  }

  async update(taskId: string, patch: Partial<ScheduledTask>): Promise<ScheduledTask | undefined> {
    const existing = this.store.get(taskId);
    if (!existing) return undefined;
    const updated = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    } as ScheduledTask;
    this.store.save(updated);
    return updated;
  }

  async toggle(taskId: string, active: boolean): Promise<ScheduledTask | undefined> {
    return this.update(taskId, { status: active ? 'active' : 'paused' } as Partial<ScheduledTask>);
  }

  createTask(params: {
    name: string;
    description?: string;
    schedule: TaskSchedule;
    action: TaskAction;
    executionConfig?: Partial<ExecutionConfig>;
    createdBy: TaskCreator;
  }): ScheduledTask {
    const now = new Date().toISOString();
    return {
      id: `legacy-task-${Math.random().toString(36).slice(2, 10)}`,
      name: params.name,
      description: params.description,
      schedule: params.schedule,
      action: params.action,
      status: 'active',
      executionConfig: {
        timeoutMs: 120_000,
        maxConsecutiveFailures: 3,
        retryCount: 1,
        retryIntervalMs: 30_000,
        onlyWhenIdle: false,
        priority: 5,
        ...params.executionConfig,
      },
      metadata: {},
      createdBy: {
        ...params.createdBy,
        name: params.createdBy.name || params.createdBy.id,
      },
      createdAt: now,
      updatedAt: now,
      nextRunAt: null,
      consecutiveFailures: 0,
    } as ScheduledTask;
  }
}

function resolveLegacyDataRoot(dataDir?: string): string {
  const resolved = path.resolve(dataDir ?? 'data/scheduled_tasks');
  return path.basename(resolved) === 'scheduled_tasks' ? path.dirname(resolved) : resolved;
}
