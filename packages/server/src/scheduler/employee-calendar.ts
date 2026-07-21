import type {
  ExecutionLog,
  ScheduledTask,
  TaskFilter,
} from '../openkuroneko/scheduled-tasks/scheduled-task-types.js';

export interface EmployeeCalendarScheduler {
  listTasks(filter?: TaskFilter): Promise<ScheduledTask[]>;
  triggerTask(taskId: string): Promise<ExecutionLog | { status: string }>;
}

export interface DueCalendarCommitment {
  id: string;
  title: string;
  priority: number;
  nextRunAt: string;
  kpiId?: string;
  expectedOutcome?: string;
}

export interface EmployeeCalendarPort {
  listDue(now?: Date): Promise<DueCalendarCommitment[]>;
  execute(commitmentId: string): Promise<void>;
}

/**
 * Calendar view over the canonical Scheduler store.
 *
 * Reading due work never consumes it. If capacity is unavailable, the task stays
 * active and due. Execution remains delegated to Scheduler so cron/interval/once,
 * retry, persistence and completion semantics keep one source of truth.
 */
export class EmployeeCalendar implements EmployeeCalendarPort {
  constructor(private readonly scheduler: EmployeeCalendarScheduler) {}

  async listDue(now = new Date()): Promise<DueCalendarCommitment[]> {
    const tasks = await this.scheduler.listTasks({ status: 'active' });
    return tasks
      .filter(
        (task) =>
          task.status === 'active' &&
          task.nextRunAt !== null &&
          Date.parse(task.nextRunAt) <= now.getTime(),
      )
      .sort((a, b) => {
        const priority = a.executionConfig.priority - b.executionConfig.priority;
        if (priority !== 0) return priority;
        return Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!);
      })
      .map((task) => ({
        id: task.id,
        title: task.name,
        priority: task.executionConfig.priority,
        nextRunAt: task.nextRunAt!,
        kpiId: typeof task.metadata['kpiId'] === 'string' ? task.metadata['kpiId'] : undefined,
        expectedOutcome:
          typeof task.metadata['expectedOutcome'] === 'string'
            ? task.metadata['expectedOutcome']
            : undefined,
      }));
  }

  async execute(commitmentId: string): Promise<void> {
    const result = await this.scheduler.triggerTask(commitmentId);
    if (result.status !== 'success' && result.status !== 'completed') {
      throw new Error(`calendar_commitment_failed:${commitmentId}:${result.status}`);
    }
  }
}
