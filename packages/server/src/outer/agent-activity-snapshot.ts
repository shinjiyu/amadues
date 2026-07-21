/**
 * 轻量 Agent 活动快照 — 聊天「状态/进度」「密度/今天」共用。
 *
 * 只消费 InnerBrainRegistry / KpiRegistry 内存记录；禁止读取 workspace、
 * brain-inspector、pi logs 或 milestones。新记录用 statusHistory 精确积分；
 * legacy 记录没有时间线时退化为 startedAt/finishedAt 估算并显式计数。
 */
import type {
  TaskRecord,
  TaskStatus,
  TaskStatusTransition,
} from './inner-brain-registry.js';
import type { KpiRecord } from './kpi-registry.js';

export const DEFAULT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set<TaskStatus>(['DONE', 'STOPPED', 'ERROR', 'ABORTED']);
const FAILED_STATUSES = new Set<TaskStatus>(['ERROR', 'ABORTED']);

export interface ActivityTaskSummary {
  instanceId: string;
  goal: string;
  status: TaskStatus;
  kpiId?: string;
  kpiDescription?: string;
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
  ticks: number;
  deliverableCount: number;
  detail?: string;
}

export interface AgentProgressSnapshot {
  activeKpis: Array<Pick<KpiRecord, 'kpiId' | 'description' | 'momentum'>>;
  running: ActivityTaskSummary[];
  blocked: ActivityTaskSummary[];
  awaiting: ActivityTaskSummary[];
  recentTerminal: ActivityTaskSummary[];
  runningSlots: number;
  freeSlots: number;
  maxRunningInnerBrains: number;
}

export interface KpiActivitySummary {
  kpiId: string;
  description: string;
  executionMs: number;
}

export interface AgentActivity24hSnapshot {
  windowStart: string;
  windowEnd: string;
  windowMs: number;
  executionMs: number;
  awaitingMs: number;
  density: number;
  started: number;
  completed: number;
  failed: number;
  stopped: number;
  estimatedTaskCount: number;
  topKpis: KpiActivitySummary[];
}

export interface AgentActivitySnapshot {
  capturedAt: string;
  progress: AgentProgressSnapshot;
  activity: AgentActivity24hSnapshot;
}

export interface BuildAgentActivitySnapshotInput {
  tasks: TaskRecord[];
  kpis: KpiRecord[];
  maxRunningInnerBrains: number;
  now?: Date;
  windowMs?: number;
}

interface TaskDurations {
  executionMs: number;
  awaitingMs: number;
  estimated: boolean;
}

function toMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function overlapMs(start: number, end: number, windowStart: number, windowEnd: number): number {
  return Math.max(0, Math.min(end, windowEnd) - Math.max(start, windowStart));
}

function terminalAt(task: TaskRecord, nowMs: number): number {
  return toMs(task.finishedAt ?? task.abortedAt, nowMs);
}

function durationsFromHistory(
  task: TaskRecord,
  history: TaskStatusTransition[],
  windowStart: number,
  nowMs: number,
): TaskDurations {
  const sorted = [...history].sort((a, b) => toMs(a.at, 0) - toMs(b.at, 0));
  let executionMs = 0;
  let awaitingMs = 0;

  for (let index = 0; index < sorted.length; index++) {
    const transition = sorted[index]!;
    const start = toMs(transition.at, toMs(task.startedAt, nowMs));
    const next = sorted[index + 1];
    const end = next
      ? toMs(next.at, nowMs)
      : TERMINAL_STATUSES.has(transition.status)
        ? terminalAt(task, start)
        : nowMs;
    const duration = overlapMs(start, end, windowStart, nowMs);
    if (transition.status === 'RUNNING') executionMs += duration;
    if (transition.status === 'AWAITING' || transition.status === 'BLOCKED') {
      awaitingMs += duration;
    }
  }
  return { executionMs, awaitingMs, estimated: false };
}

function estimateLegacyDurations(
  task: TaskRecord,
  windowStart: number,
  nowMs: number,
): TaskDurations {
  const start = toMs(task.startedAt, nowMs);
  if (task.status === 'AWAITING' || task.status === 'BLOCKED') {
    return {
      executionMs: 0,
      awaitingMs: overlapMs(start, nowMs, windowStart, nowMs),
      estimated: true,
    };
  }
  const end = TERMINAL_STATUSES.has(task.status) ? terminalAt(task, nowMs) : nowMs;
  return {
    executionMs: overlapMs(start, end, windowStart, nowMs),
    awaitingMs: 0,
    estimated: true,
  };
}

function taskDurations(task: TaskRecord, windowStart: number, nowMs: number): TaskDurations {
  if (task.statusHistory && task.statusHistory.length > 0) {
    return durationsFromHistory(task, task.statusHistory, windowStart, nowMs);
  }
  return estimateLegacyDurations(task, windowStart, nowMs);
}

function summarizeTask(
  task: TaskRecord,
  kpiById: Map<string, KpiRecord>,
  nowMs: number,
): ActivityTaskSummary {
  const end = TERMINAL_STATUSES.has(task.status) ? terminalAt(task, nowMs) : nowMs;
  const kpi = task.kpiId ? kpiById.get(task.kpiId) : undefined;
  return {
    instanceId: task.instanceId,
    goal: task.goal,
    status: task.status,
    kpiId: task.kpiId,
    kpiDescription: kpi?.description,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt ?? task.abortedAt,
    elapsedMs: Math.max(0, end - toMs(task.startedAt, end)),
    ticks: task.ticks ?? 0,
    deliverableCount: task.deliverableCount ?? 0,
    detail: task.errorMessage ?? task.abortReason,
  };
}

export function buildAgentActivitySnapshot(
  input: BuildAgentActivitySnapshotInput,
): AgentActivitySnapshot {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const windowMs = Math.max(1, input.windowMs ?? DEFAULT_ACTIVITY_WINDOW_MS);
  const windowStart = nowMs - windowMs;
  const maxSlots = Math.max(0, input.maxRunningInnerBrains);
  const kpiById = new Map(input.kpis.map((kpi) => [kpi.kpiId, kpi]));

  const running = input.tasks.filter((task) => task.status === 'RUNNING');
  const blocked = input.tasks.filter((task) => task.status === 'BLOCKED');
  const awaiting = input.tasks.filter((task) => task.status === 'AWAITING');
  const terminal = input.tasks
    .filter((task) => TERMINAL_STATUSES.has(task.status))
    .sort((a, b) => terminalAt(b, nowMs) - terminalAt(a, nowMs))
    .slice(0, 5);

  let executionMs = 0;
  let awaitingMs = 0;
  let estimatedTaskCount = 0;
  const executionByKpi = new Map<string, number>();

  for (const task of input.tasks) {
    const durations = taskDurations(task, windowStart, nowMs);
    executionMs += durations.executionMs;
    awaitingMs += durations.awaitingMs;
    if (durations.estimated && durations.executionMs + durations.awaitingMs > 0) {
      estimatedTaskCount++;
    }
    if (task.kpiId && durations.executionMs > 0) {
      executionByKpi.set(
        task.kpiId,
        (executionByKpi.get(task.kpiId) ?? 0) + durations.executionMs,
      );
    }
  }

  const finishedInWindow = input.tasks.filter((task) => {
    if (!TERMINAL_STATUSES.has(task.status)) return false;
    const at = terminalAt(task, 0);
    return at >= windowStart && at <= nowMs;
  });
  const started = input.tasks.filter((task) => {
    const at = toMs(task.startedAt, 0);
    return at >= windowStart && at <= nowMs;
  }).length;

  const denominator = windowMs * maxSlots;
  const density = denominator > 0 ? Math.min(1, executionMs / denominator) : 0;
  const topKpis = [...executionByKpi.entries()]
    .map(([kpiId, duration]) => ({
      kpiId,
      description: kpiById.get(kpiId)?.description ?? kpiId,
      executionMs: duration,
    }))
    .sort((a, b) => b.executionMs - a.executionMs)
    .slice(0, 3);

  return {
    capturedAt: now.toISOString(),
    progress: {
      activeKpis: input.kpis
        .filter((kpi) => kpi.status === 'active')
        .map(({ kpiId, description, momentum }) => ({ kpiId, description, momentum }))
        .sort((a, b) => b.momentum - a.momentum),
      running: running.map((task) => summarizeTask(task, kpiById, nowMs)),
      blocked: blocked.map((task) => summarizeTask(task, kpiById, nowMs)),
      awaiting: awaiting.map((task) => summarizeTask(task, kpiById, nowMs)),
      recentTerminal: terminal.map((task) => summarizeTask(task, kpiById, nowMs)),
      runningSlots: running.length,
      freeSlots: Math.max(0, maxSlots - running.length),
      maxRunningInnerBrains: maxSlots,
    },
    activity: {
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: now.toISOString(),
      windowMs,
      executionMs,
      awaitingMs,
      density,
      started,
      completed: finishedInWindow.filter((task) => task.status === 'DONE').length,
      failed: finishedInWindow.filter((task) => FAILED_STATUSES.has(task.status)).length,
      stopped: finishedInWindow.filter((task) => task.status === 'STOPPED').length,
      estimatedTaskCount,
      topKpis,
    },
  };
}
