/**
 * Scheduled Task Type Definitions.
 *
 * All types for the heartbeat-driven task scheduling module.
 * Based on Design Option D: heartbeat-driven scheduling with persistent storage.
 *
 * Schedule types:
 *   - cron:      standard 5-field cron expression
 *   - interval:  fixed-interval repetition (ms)
 *   - once:      one-shot execution at a specific time
 *
 * Action types:
 *   - prompt:       inject a prompt into the Agent
 *   - tool_call:    invoke a registered tool by name
 *   - send_message: post a message to an IM conversation
 */

// ── Schedule Rules ────────────────────────────────────────────────────────────

export interface CronSchedule {
  readonly type: 'cron';
  /** Standard 5-field cron expression (min hour day month weekday) */
  expression: string;
  /** IANA timezone, defaults to "Asia/Shanghai" */
  timezone?: string;
}

export interface IntervalSchedule {
  readonly type: 'interval';
  /** Repetition interval in milliseconds */
  intervalMs: number;
  /** Delay before first execution (ms), defaults to 0 */
  startDelayMs?: number;
}

export interface OnceSchedule {
  readonly type: 'once';
  /** Planned execution time (ISO 8601) */
  runAt: string;
}

export type ScheduleRule = CronSchedule | IntervalSchedule | OnceSchedule;

// ── Task Actions ──────────────────────────────────────────────────────────────

export interface PromptAction {
  readonly type: 'prompt';
  /** Prompt content for the Agent to execute */
  content: string;
  /** Whether to include conversation context */
  includeContext?: boolean;
}

export interface ToolCallAction {
  readonly type: 'tool_call';
  /** Registered tool name */
  tool: string;
  /** Tool parameters */
  params?: Record<string, unknown>;
}

export interface SendMessageAction {
  readonly type: 'send_message';
  /** Message content to send */
  content: string;
  /** Target conversation or channel (optional, uses default if omitted) */
  channel?: string;
}

export type TaskAction = PromptAction | ToolCallAction | SendMessageAction;

// ── Task Status ───────────────────────────────────────────────────────────────

export type TaskStatus = 'active' | 'paused' | 'completed' | 'archived' | 'error';

// ── Execution Config ──────────────────────────────────────────────────────────

export interface TaskExecutionConfig {
  /** Maximum execution time (ms), default 120000 (2 minutes) */
  timeoutMs: number;
  /** Max consecutive failures before auto-pause, default 3 */
  maxConsecutiveFailures: number;
  /** Retry count on failure, default 1 */
  retryCount: number;
  /** Retry interval (ms), default 30000 (30 seconds) */
  retryIntervalMs: number;
  /** Only execute when Agent is idle, default false */
  onlyWhenIdle: boolean;
  /** Task priority (higher = earlier execution), default 0 */
  priority: number;
}

// ── Task Creator ──────────────────────────────────────────────────────────────

export type CreatorType = 'user' | 'agent' | 'system';

export interface TaskCreator {
  /** Creator type identifier */
  type: CreatorType;
  /** Unique creator ID (user ID, agent ID, etc.) */
  id: string;
  /** Human-readable creator name */
  name: string;
}

// ── Scheduled Task ────────────────────────────────────────────────────────────

export interface ScheduledTask {
  /** Unique task identifier */
  id: string;
  /** Human-readable task name */
  name: string;
  /** Task description */
  description?: string;
  /** Schedule rule (cron, interval, or once) */
  schedule: ScheduleRule;
  /** Action to execute when task is due */
  action: TaskAction;
  /** Current task status */
  status: TaskStatus;
  /** Execution configuration */
  executionConfig: TaskExecutionConfig;
  /** Additional metadata */
  metadata: Record<string, unknown>;
  /** Who created this task */
  createdBy: TaskCreator;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last update timestamp */
  updatedAt: string;
  /** ISO 8601 next scheduled execution time */
  nextRunAt: string | null;
  /** ISO 8601 last execution time */
  lastRunAt?: string;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Tags for categorization */
  tags?: string[];
}

// ── Execution Status ──────────────────────────────────────────────────────────

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'completed'
  | 'skipped'
  | 'missed';

// ── Execution Log ─────────────────────────────────────────────────────────────

export interface ExecutionLog {
  /** Unique execution identifier */
  executionId: string;
  /** Associated task ID */
  taskId: string;
  /** Execution status */
  status: ExecutionStatus;
  /** ISO 8601 start timestamp */
  startedAt: string;
  /** ISO 8601 finish timestamp */
  finishedAt?: string;
  /** Execution duration in ms */
  durationMs?: number;
  /** Execution result (truncated) */
  result?: string;
  /** Error message on failure */
  error?: string;
  /** Whether this is a retry execution */
  isRetry: boolean;
  /** Retry attempt number (0 = first attempt) */
  retryAttempt: number;
}

// ── CRUD Requests ─────────────────────────────────────────────────────────────

export interface CreateTaskRequest {
  name: string;
  description?: string;
  schedule: ScheduleRule;
  action: TaskAction;
  executionConfig?: Partial<TaskExecutionConfig>;
  metadata?: Record<string, unknown>;
  tags?: string[];
  createdBy: TaskCreator;
}

export interface UpdateTaskRequest {
  name?: string;
  description?: string;
  schedule?: ScheduleRule;
  action?: TaskAction;
  executionConfig?: Partial<TaskExecutionConfig>;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

// ── Task Filter ───────────────────────────────────────────────────────────────

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  tags?: string[];
  scheduleType?: 'cron' | 'interval' | 'once';
  createdByType?: CreatorType;
}

// ── Scheduler Status ──────────────────────────────────────────────────────────

export interface SchedulerStatus {
  /** Whether the scheduler loop is currently active */
  isRunning: boolean;
  /** Number of active tasks */
  activeTaskCount: number;
  /** Number of paused tasks */
  pausedTaskCount: number;
  /** The next due task info, or null if none scheduled */
  nextDueTask: { name: string; dueAt: string } | null;
  /** ISO 8601 timestamp of the last heartbeat check */
  lastCheckAt: string | null;
  /** Number of tasks that were missed during downtime */
  missedTaskCount: number;
}

// ── Runtime State (used by TaskStore) ─────────────────────────────────────────

/**
 * Runtime scheduler state, persisted to state.json.
 * Extends SchedulerStateFile with 'idle' status for fresh/default state.
 */
export interface SchedulerState {
  lastHeartbeatAt?: string;
  schedulerStatus: 'running' | 'stopped' | 'idle';
  totalExecutions: number;
}

/** Additional metadata attached to a task for display or categorization */
export interface TaskMetadata {
  /** Human-readable description */
  description?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Custom key-value pairs */
  extra?: Record<string, string>;
}
