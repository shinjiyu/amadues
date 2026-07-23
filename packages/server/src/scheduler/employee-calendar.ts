import type {
  CreateTaskRequest,
  ExecutionLog,
  ScheduleRule,
  ScheduledTask,
  TaskAction,
  TaskFilter,
  TaskStatus,
  UpdateTaskRequest,
} from '../openkuroneko/scheduled-tasks/scheduled-task-types.js';

/** ADL EMPLOYEE-CALENDAR.md §2 */
export type CalendarPurpose =
  | 'kpi_increment'
  | 'chat_appointment'
  | 'one_shot_task'
  | 'tool_call'
  | 'system';

export const CALENDAR_PURPOSES: readonly CalendarPurpose[] = [
  'kpi_increment',
  'chat_appointment',
  'one_shot_task',
  'tool_call',
  'system',
] as const;

/** 单 agent 活跃承诺上限（C3） */
export const MAX_ACTIVE_CALENDAR_COMMITMENTS = 50;

/** interval / 过密 cron 地板（C3） */
export const MIN_CALENDAR_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 日历 due 时可自动执行的外脑工具白名单（C4）。
 * 不含 set_goal / advance_kpi / 发消息等高副作用；spawn 走 prompt action。
 */
export const CALENDAR_DUE_TOOL_CALL_ALLOWLIST = new Set<string>([
  'list_kpis',
  'list_calendar',
  'view_kpi',
  'get_time',
  'read_autonomy_policy',
  'read_performance_goals',
  'list_inner_brains',
  'read_memory',
]);

export interface EmployeeCalendarScheduler {
  listTasks(filter?: TaskFilter): Promise<ScheduledTask[]>;
  triggerTask(taskId: string): Promise<ExecutionLog | { status: string }>;
  createTask?(request: CreateTaskRequest): Promise<ScheduledTask | string>;
  updateTask?(taskId: string, request: UpdateTaskRequest): Promise<ScheduledTask>;
  deleteTask?(taskId: string): Promise<boolean>;
  pauseTask?(taskId: string): Promise<ScheduledTask>;
  resumeTask?(taskId: string): Promise<ScheduledTask>;
}

export interface DueCalendarCommitment {
  id: string;
  title: string;
  priority: number;
  nextRunAt: string;
  kpiId?: string;
  expectedOutcome?: string;
  purpose?: CalendarPurpose;
  actionType?: TaskAction['type'];
  calendarKey?: string;
  originThreadId?: string;
}

export interface CalendarCommitmentView {
  id: string;
  title: string;
  status: string;
  nextRunAt: string | null;
  kpiId?: string;
  expectedOutcome?: string;
  calendarKey?: string;
  purpose?: CalendarPurpose;
  actionType?: TaskAction['type'];
  originThreadId?: string;
  scheduleType?: ScheduleRule['type'];
}

export interface EnsurePeriodicCommitmentInput {
  calendarKey: string;
  kpiId: string;
  title: string;
  expectedOutcome: string;
  /** due 时 set_goal 的窄 prompt */
  prompt: string;
  /** cron 表达式，默认每天 01:00 UTC */
  cron?: string;
  agentId: string;
}

export interface UpsertCommitmentInput {
  calendarKey: string;
  title: string;
  purpose: CalendarPurpose;
  schedule: ScheduleRule;
  action: TaskAction;
  expectedOutcome: string;
  agentId: string;
  kpiId?: string;
  originThreadId?: string;
  originUserSid?: string;
  priority?: number;
  /** 额外 metadata（如 seedKind） */
  extraMetadata?: Record<string, unknown>;
  createdByType?: 'user' | 'agent' | 'system';
  /**
   * ensure：已存在则 no-op（ADV-6）。
   * upsert（默认）：已存在则刷新 schedule/action/metadata。
   */
  mode?: 'ensure' | 'upsert';
}

export interface ListCommitmentsFilter {
  purpose?: CalendarPurpose;
  kpiId?: string;
  status?: TaskStatus | TaskStatus[];
  originThreadId?: string;
  calendarKey?: string;
}

export interface EmployeeCalendarPort {
  listDue(now?: Date): Promise<DueCalendarCommitment[]>;
  execute(commitmentId: string): Promise<void>;
  listByKpi?(kpiId: string): Promise<CalendarCommitmentView[]>;
  listCommitments?(filter?: ListCommitmentsFilter): Promise<CalendarCommitmentView[]>;
  upsertCommitment?(
    input: UpsertCommitmentInput,
  ): Promise<{ created: boolean; id: string; updated: boolean }>;
  cancelCommitment?(idOrKey: string): Promise<{ cancelled: boolean; id?: string }>;
  pauseCommitment?(idOrKey: string): Promise<{ paused: boolean; id?: string }>;
  resumeCommitment?(idOrKey: string): Promise<{ resumed: boolean; id?: string }>;
  ensurePeriodicCommitment?(
    input: EnsurePeriodicCommitmentInput,
  ): Promise<{ created: boolean; id: string }>;
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
      .map((task) => mapDue(task));
  }

  async listByKpi(kpiId: string): Promise<CalendarCommitmentView[]> {
    return this.listCommitments({ kpiId, status: 'active' });
  }

  /** 列出全部 active 任务（供感知面扫 metadata） */
  async listActiveCommitments(): Promise<CalendarCommitmentView[]> {
    return this.listCommitments({ status: 'active' });
  }

  async listCommitments(filter: ListCommitmentsFilter = {}): Promise<CalendarCommitmentView[]> {
    const status = filter.status ?? (['active', 'paused'] as TaskStatus[]);
    const tasks = await this.scheduler.listTasks({ status });
    return tasks.filter((task) => matchFilter(task, filter)).map((task) => mapView(task));
  }

  /**
   * 通用写入：同 calendarKey 幂等。
   * ensure 模式不刷新已有条目；upsert 刷新 schedule/action/文案。
   */
  async upsertCommitment(
    input: UpsertCommitmentInput,
  ): Promise<{ created: boolean; id: string; updated: boolean }> {
    assertValidPurpose(input.purpose);
    assertScheduleFloor(input.schedule);
    if (input.action.type === 'tool_call') {
      assertToolCallAllowlisted(input.action.tool);
    }
    if (!input.title.trim()) {
      throw new Error('calendar_title_required');
    }
    if (!input.calendarKey.trim()) {
      throw new Error('calendar_key_required');
    }
    if (input.purpose === 'kpi_increment' && !input.kpiId) {
      throw new Error('calendar_kpi_increment_requires_kpi_id');
    }

    const mode = input.mode ?? 'upsert';
    const existing = await this.findByKeyOrLegacy(input.calendarKey, input.kpiId, input.purpose);

    if (existing) {
      if (mode === 'ensure') {
        return { created: false, id: existing.id, updated: false };
      }
      if (!this.scheduler.updateTask) {
        throw new Error('calendar_upsert_requires_updateTask');
      }
      await this.scheduler.updateTask(existing.id, {
        name: input.title,
        description: input.expectedOutcome,
        schedule: input.schedule,
        action: input.action,
        metadata: buildMetadata(input),
        executionConfig: { priority: input.priority ?? existing.executionConfig.priority },
      });
      return { created: false, id: existing.id, updated: true };
    }

    await this.assertUnderActiveCap();
    if (!this.scheduler.createTask) {
      throw new Error('calendar_upsert_requires_createTask');
    }
    const created = await this.scheduler.createTask({
      name: input.title,
      description: input.expectedOutcome,
      schedule: input.schedule,
      action: input.action,
      metadata: buildMetadata(input),
      createdBy: {
        type: input.createdByType ?? 'agent',
        id: input.agentId,
        name: input.agentId,
      },
      executionConfig: { priority: input.priority ?? 5, onlyWhenIdle: false },
    });
    const id = typeof created === 'string' ? created : created.id;
    return { created: true, id, updated: false };
  }

  /** ADV-6：同 calendarKey 至多一条；已存在则 no-op（经 upsert ensure） */
  async ensurePeriodicCommitment(
    input: EnsurePeriodicCommitmentInput,
  ): Promise<{ created: boolean; id: string }> {
    const result = await this.upsertCommitment({
      calendarKey: input.calendarKey,
      title: input.title,
      purpose: 'kpi_increment',
      schedule: {
        type: 'cron',
        expression: input.cron ?? '0 1 * * *',
        timezone: 'UTC',
      },
      action: { type: 'prompt', content: input.prompt },
      expectedOutcome: input.expectedOutcome,
      agentId: input.agentId,
      kpiId: input.kpiId,
      priority: 5,
      createdByType: 'system',
      extraMetadata: { seedKind: 'increment' },
      mode: 'ensure',
    });
    return { created: result.created, id: result.id };
  }

  async cancelCommitment(idOrKey: string): Promise<{ cancelled: boolean; id?: string }> {
    const task = await this.resolveIdOrKey(idOrKey);
    if (!task) return { cancelled: false };
    if (!this.scheduler.deleteTask) {
      throw new Error('calendar_cancel_requires_deleteTask');
    }
    const ok = await this.scheduler.deleteTask(task.id);
    return { cancelled: ok, id: task.id };
  }

  async pauseCommitment(idOrKey: string): Promise<{ paused: boolean; id?: string }> {
    const task = await this.resolveIdOrKey(idOrKey);
    if (!task) return { paused: false };
    if (!this.scheduler.pauseTask) {
      throw new Error('calendar_pause_requires_pauseTask');
    }
    await this.scheduler.pauseTask(task.id);
    return { paused: true, id: task.id };
  }

  async resumeCommitment(idOrKey: string): Promise<{ resumed: boolean; id?: string }> {
    const task = await this.resolveIdOrKey(idOrKey);
    if (!task) return { resumed: false };
    if (!this.scheduler.resumeTask) {
      throw new Error('calendar_resume_requires_resumeTask');
    }
    await this.scheduler.resumeTask(task.id);
    return { resumed: true, id: task.id };
  }

  async execute(commitmentId: string): Promise<void> {
    const result = await this.scheduler.triggerTask(commitmentId);
    if (result.status !== 'success' && result.status !== 'completed') {
      throw new Error(`calendar_commitment_failed:${commitmentId}:${result.status}`);
    }
  }

  private async findByKeyOrLegacy(
    calendarKey: string,
    kpiId: string | undefined,
    purpose: CalendarPurpose,
  ): Promise<ScheduledTask | undefined> {
    const tasks = await this.scheduler.listTasks({
      status: ['active', 'paused'] as TaskStatus[],
    });
    const byKey = tasks.find((task) => task.metadata['calendarKey'] === calendarKey);
    if (byKey) return byKey;

    // ADV-6 遗留回退：仅当调用方写入「规范键」`{kpiId}:increment` 时，
    // 才用 kpiId+seedKind 找回早期无 calendarKey / 仅 seedKind 的条目。
    // 禁止：任意显式 key（如 twitter-morning）回落匹配同 KPI 的 increment，
    // 否则一天三班会被互相 upsert 冲成一条。
    const canonicalIncrementKey =
      purpose === 'kpi_increment' && kpiId ? `${kpiId.trim()}:increment` : null;
    if (canonicalIncrementKey && calendarKey === canonicalIncrementKey) {
      return tasks.find((task) => {
        if (task.metadata['kpiId'] !== kpiId || task.metadata['seedKind'] !== 'increment') {
          return false;
        }
        const existingKey = task.metadata['calendarKey'];
        return (
          existingKey == null ||
          existingKey === '' ||
          existingKey === canonicalIncrementKey
        );
      });
    }
    return undefined;
  }

  private async resolveIdOrKey(idOrKey: string): Promise<ScheduledTask | undefined> {
    const tasks = await this.scheduler.listTasks({
      status: ['active', 'paused', 'error'] as TaskStatus[],
    });
    return (
      tasks.find((task) => task.id === idOrKey) ??
      tasks.find((task) => task.metadata['calendarKey'] === idOrKey)
    );
  }

  private async assertUnderActiveCap(): Promise<void> {
    const active = await this.scheduler.listTasks({ status: 'active' });
    if (active.length >= MAX_ACTIVE_CALENDAR_COMMITMENTS) {
      throw new Error(`calendar_active_cap:${MAX_ACTIVE_CALENDAR_COMMITMENTS}`);
    }
  }
}

export function assertScheduleFloor(schedule: ScheduleRule): void {
  if (schedule.type === 'interval') {
    if (schedule.intervalMs < MIN_CALENDAR_INTERVAL_MS) {
      throw new Error(`calendar_schedule_too_frequent:min_interval_ms=${MIN_CALENDAR_INTERVAL_MS}`);
    }
    return;
  }
  if (schedule.type === 'cron') {
    const minute = schedule.expression.trim().split(/\s+/)[0] ?? '';
    if (minute === '*' || /^\*\/[1-4]$/.test(minute)) {
      throw new Error('calendar_cron_too_frequent:min_step_5m');
    }
  }
}

export function assertToolCallAllowlisted(toolName: string): void {
  if (!CALENDAR_DUE_TOOL_CALL_ALLOWLIST.has(toolName)) {
    throw new Error(`calendar_tool_call_not_allowlisted:${toolName}`);
  }
}

export function assertValidPurpose(purpose: string): asserts purpose is CalendarPurpose {
  if (!CALENDAR_PURPOSES.includes(purpose as CalendarPurpose)) {
    throw new Error(`calendar_invalid_purpose:${purpose}`);
  }
}

function buildMetadata(input: UpsertCommitmentInput): Record<string, unknown> {
  return {
    ...(input.purpose === 'kpi_increment' ? { seedKind: 'increment' } : {}),
    ...(input.extraMetadata ?? {}),
    purpose: input.purpose,
    calendarKey: input.calendarKey,
    expectedOutcome: input.expectedOutcome,
    ...(input.kpiId ? { kpiId: input.kpiId } : {}),
    ...(input.originThreadId ? { originThreadId: input.originThreadId } : {}),
    ...(input.originUserSid ? { originUserSid: input.originUserSid } : {}),
  };
}

function matchFilter(task: ScheduledTask, filter: ListCommitmentsFilter): boolean {
  if (filter.kpiId && task.metadata['kpiId'] !== filter.kpiId) return false;
  if (filter.calendarKey && task.metadata['calendarKey'] !== filter.calendarKey) return false;
  if (filter.purpose) {
    const purpose = task.metadata['purpose'];
    if (purpose !== filter.purpose) {
      // legacy KPI increment rows may lack purpose
      if (
        !(
          filter.purpose === 'kpi_increment' &&
          task.metadata['seedKind'] === 'increment' &&
          !purpose
        )
      ) {
        return false;
      }
    }
  }
  if (filter.originThreadId && task.metadata['originThreadId'] !== filter.originThreadId) {
    return false;
  }
  return true;
}

function mapDue(task: ScheduledTask): DueCalendarCommitment {
  return {
    ...mapCommon(task),
    priority: task.executionConfig.priority,
    nextRunAt: task.nextRunAt!,
  };
}

function mapView(task: ScheduledTask): CalendarCommitmentView {
  return {
    ...mapCommon(task),
    status: task.status,
    nextRunAt: task.nextRunAt,
    scheduleType: task.schedule.type,
  };
}

function mapCommon(task: ScheduledTask): {
  id: string;
  title: string;
  kpiId?: string;
  expectedOutcome?: string;
  calendarKey?: string;
  purpose?: CalendarPurpose;
  actionType?: TaskAction['type'];
  originThreadId?: string;
} {
  const purposeRaw = task.metadata['purpose'];
  const purpose =
    typeof purposeRaw === 'string' && CALENDAR_PURPOSES.includes(purposeRaw as CalendarPurpose)
      ? (purposeRaw as CalendarPurpose)
      : task.metadata['seedKind'] === 'increment'
        ? 'kpi_increment'
        : undefined;
  return {
    id: task.id,
    title: task.name,
    kpiId: typeof task.metadata['kpiId'] === 'string' ? task.metadata['kpiId'] : undefined,
    expectedOutcome:
      typeof task.metadata['expectedOutcome'] === 'string'
        ? task.metadata['expectedOutcome']
        : undefined,
    calendarKey:
      typeof task.metadata['calendarKey'] === 'string' ? task.metadata['calendarKey'] : undefined,
    purpose,
    actionType: task.action.type,
    originThreadId:
      typeof task.metadata['originThreadId'] === 'string'
        ? task.metadata['originThreadId']
        : undefined,
  };
}
