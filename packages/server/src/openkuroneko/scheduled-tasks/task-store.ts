/**
 * TaskStore -- Persistent storage layer for scheduled tasks.
 *
 * Persists task definitions and execution logs to JSON files,
 * following the same file storage pattern as InnerBrainRegistry
 * (dataRoot/scheduled_tasks/ directory).
 *
 * Storage structure:
 *   dataRoot/scheduled_tasks/
 *     +-- tasks.json          # All task definitions
 *     +-- logs/
 *     |   +-- {taskId}/
 *     |       +-- {executionId}.json
 *     +-- state.json          # Scheduler runtime state
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ScheduledTask,
  ExecutionLog,
  TaskFilter,
  SchedulerState,
} from './scheduled-task-types.js';

// -- tasks.json file structure --

interface TasksFile {
  version: number;
  tasks: ScheduledTask[];
  lastModified: string;
}

// -- TaskStore --

/** Configuration for TaskStore */
export interface TaskStoreConfig {
  /** Base directory containing scheduled_tasks/ */
  dataRoot: string;
}

export class TaskStore {
  /** Base data root directory */
  readonly dataRoot: string;
  private readonly tasksDir: string;
  private readonly tasksFilePath: string;
  private readonly logsDir: string;
  private readonly stateFilePath: string;

  /** In-memory cache to avoid frequent file reads */
  private tasks: Map<string, ScheduledTask> = new Map();

  constructor(configOrDataRoot: string | TaskStoreConfig) {
    const dataRoot = typeof configOrDataRoot === 'string'
      ? configOrDataRoot
      : configOrDataRoot.dataRoot;
    this.dataRoot = dataRoot;
    this.tasksDir = path.join(dataRoot, 'scheduled_tasks');
    this.tasksFilePath = path.join(this.tasksDir, 'tasks.json');
    this.logsDir = path.join(this.tasksDir, 'logs');
    this.stateFilePath = path.join(this.tasksDir, 'state.json');

    // Ensure directory structure exists
    fs.mkdirSync(this.tasksDir, { recursive: true });
    fs.mkdirSync(this.logsDir, { recursive: true });

    // Load persisted tasks
    this._loadTasks();
  }

  // -- Initialization --

  /**
   * Async alias for initialize().
   * TaskScheduler calls this during its own async initialize().
   */
  async load(): Promise<void> {
    // Already loaded in constructor; this is for API compatibility.
  }

  // -- Task CRUD --

  /** Save (create or update) a task */
  save(task: ScheduledTask): void {
    this.tasks.set(task.id, task);
    this._persistTasks();
  }

  /** Get a single task by ID */
  get(taskId: string): ScheduledTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Remove a task by ID */
  remove(taskId: string): void {
    this.tasks.delete(taskId);
    this._persistTasks();
  }

  /** List all tasks */
  listAll(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  /** Query tasks with filter */
  query(filter?: TaskFilter): ScheduledTask[] {
    let tasks = this.listAll();
    if (!filter) return tasks;

    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      tasks = tasks.filter((t) => statuses.includes(t.status));
    }
    if (filter.tags && filter.tags.length > 0) {
      tasks = tasks.filter(t =>
        Array.isArray(t.metadata?.tags) && (t.metadata.tags as string[]).some((tag: string) => filter.tags!.includes(tag)),
      );
    }
    return tasks;
  }

  /** Search tasks by keyword */
  search(query: string): ScheduledTask[] {
    const q = query.toLowerCase();
    return this.listAll().filter(
      t =>
        t.name.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q),
    );
  }

  /** List all active tasks */
  listActive(): ScheduledTask[] {
    return this.listAll().filter(t => t.status === 'active');
  }

  /** List all paused tasks */
  listPaused(): ScheduledTask[] {
    return this.listAll().filter(t => t.status === 'paused');
  }

  /**
   * Alias for listActive(). Used by TaskScheduler internally.
   */
  getAllActive(): ScheduledTask[] {
    return this.listActive();
  }

  /**
   * Alias for listAll(). Used by TaskMonitor and other consumers.
   */
  listTasks(): ScheduledTask[] {
    return this.listAll();
  }

  /** Return total task count */
  taskCount(): number {
    return this.tasks.size;
  }

  /**
   * Flush pending data to disk.
   * Since save() writes synchronously, this is a no-op but provided
   * for API compatibility with TaskScheduler's async usage.
   */
  async flush(): Promise<void> {
    // All writes in save() are synchronous; nothing to flush.
  }

  // -- Execution Logs --

  /** Get all execution logs for a specific task */
  getLogs(taskId: string): ExecutionLog[] {
    return this.queryLogs({ taskId, limit: 1000 });
  }

  /** Append an execution log */
  appendLog(log: ExecutionLog): void {
    const taskLogDir = path.join(this.logsDir, log.taskId);
    fs.mkdirSync(taskLogDir, { recursive: true });
    const logPath = path.join(taskLogDir, `${log.executionId}.json`);
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
  }

  /** Update an existing execution log */
  updateLog(log: ExecutionLog): void {
    const taskLogDir = path.join(this.logsDir, log.taskId);
    const logPath = path.join(taskLogDir, `${log.executionId}.json`);
    if (fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
    }
  }

  /** Query execution logs with filter */
  queryLogs(filter: {
    taskId?: string;
    status?: string;
    limit?: number;
    offset?: number;
    since?: string;
    until?: string;
  }): ExecutionLog[] {
    let logs: ExecutionLog[] = [];

    if (filter.taskId) {
      // Load logs for a specific task
      const taskLogDir = path.join(this.logsDir, filter.taskId);
      if (fs.existsSync(taskLogDir)) {
        const files = fs.readdirSync(taskLogDir)
          .filter(f => f.endsWith('.json'))
          .sort()
          .reverse(); // Most recent first

        for (const file of files) {
          try {
            const log = JSON.parse(
              fs.readFileSync(path.join(taskLogDir, file), 'utf8'),
            ) as ExecutionLog;
            logs.push(log);
          } catch {
            // Skip corrupted log files
          }
        }
      }
    } else {
      // Load all logs from all tasks
      const taskDirs = this._getTaskLogDirs();
      for (const dir of taskDirs) {
        const files = fs.readdirSync(dir)
          .filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const log = JSON.parse(
              fs.readFileSync(path.join(dir, file), 'utf8'),
            ) as ExecutionLog;
            logs.push(log);
          } catch {
            // Skip corrupted log files
          }
        }
      }
      // Sort by startedAt descending
      logs.sort((a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      );
    }

    // Apply filters
    if (filter.status) {
      logs = logs.filter(l => l.status === filter.status);
    }
    if (filter.since) {
      const sinceTime = new Date(filter.since).getTime();
      logs = logs.filter(l => new Date(l.startedAt).getTime() >= sinceTime);
    }
    if (filter.until) {
      const untilTime = new Date(filter.until).getTime();
      logs = logs.filter(l => new Date(l.startedAt).getTime() <= untilTime);
    }

    // Apply pagination
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    logs = logs.slice(offset, offset + limit);

    return logs;
  }

  // -- State Persistence --

  /** Load scheduler state from state.json */
  loadState(): SchedulerState {
    if (!fs.existsSync(this.stateFilePath)) {
      return {
        schedulerStatus: 'idle',
        totalExecutions: 0,
      };
    }
    try {
      return JSON.parse(
        fs.readFileSync(this.stateFilePath, 'utf8'),
      ) as SchedulerState;
    } catch {
      return {
        schedulerStatus: 'idle',
        totalExecutions: 0,
      };
    }
  }

  /** Save scheduler state to state.json */
  saveState(state: SchedulerState): void {
    fs.writeFileSync(
      this.stateFilePath,
      JSON.stringify(state, null, 2),
      'utf8',
    );
  }

  // -- Private Helpers --

  /** Get all task log directories */
  private _getTaskLogDirs(): string[] {
    if (!fs.existsSync(this.logsDir)) return [];
    return fs
      .readdirSync(this.logsDir)
      .map(name => path.join(this.logsDir, name))
      .filter(p => fs.statSync(p).isDirectory());
  }

  private _loadTasks(): void {
    if (!fs.existsSync(this.tasksFilePath)) return;
    try {
      const file = JSON.parse(
        fs.readFileSync(this.tasksFilePath, 'utf8'),
      ) as TasksFile;
      if (file.version === 1 && Array.isArray(file.tasks)) {
        for (const task of file.tasks) {
          this.tasks.set(task.id, task);
        }
      }
    } catch {
      console.error('[scheduled-tasks] tasks.json parse error, starting empty');
    }
  }

  private _persistTasks(): void {
    const file: TasksFile = {
      version: 1,
      tasks: Array.from(this.tasks.values()),
      lastModified: new Date().toISOString(),
    };
    // Atomic write: write to temp file then rename
    const tmp = this.tasksFilePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    fs.renameSync(tmp, this.tasksFilePath);
  }
}
