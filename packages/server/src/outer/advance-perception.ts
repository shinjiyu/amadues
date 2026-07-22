/**
 * 推进感知面 — ADL KPI-ADVANCE-WORK-PACKAGE.md §2
 *
 * 调配前可读：本 KPI 内脑是否健康在途、是否已有未到期周期日程、基线是否做过、近期 stall。
 * 与 Dashboard enricher 同源 liveness 规则（5min stuck）；stall 与 burst-stall-alert 索引同源。
 */
import { isPidAlive, readWorkerStatus } from '../pi-mono/inner-brain-spawner.js';
import type { TaskRecord } from './inner-brain-registry.js';
import type { BurstRunRecord } from './kpi-registry.js';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
/** 近期 stall 窗口：超出则不进入 needingRepair */
export const STALL_PERCEPTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type BurstLiveness = 'active' | 'stuck' | 'dead' | null;

export interface AdvanceInnerBurstView {
  instanceId: string;
  kpiId?: string;
  status: TaskRecord['status'];
  liveness: BurstLiveness;
  lastTickAt: string | null;
  deliverableCount: number;
}

export interface AdvanceCalendarCommitmentView {
  id: string;
  kpiId?: string;
  title: string;
  /** nextRunAt <= now → due；否则 scheduled（未到期） */
  phase: 'due' | 'scheduled';
  nextRunAt: string | null;
  expectedOutcome?: string;
  calendarKey?: string;
}

export interface AdvanceStallView {
  alertId: string;
  instanceId: string;
  kpiId?: string;
  severity: 'warn' | 'critical';
  signals: string[];
  summary: string;
  ts: string;
}

export interface AdvancePerception {
  /** 健康 RUNNING（liveness=active）的 kpiId */
  kpiIdsWithHealthyRunning: string[];
  /** stuck/dead RUNNING 的 kpiId（监督路径，默认也不再整单推进） */
  kpiIdsWithUnhealthyRunning: string[];
  /** 任一 RUNNING/AWAITING/BLOCKED 在途 */
  kpiIdsWithInFlight: string[];
  /** 有未到期周期承诺（nextRunAt > now） */
  kpiIdsWithFuturePeriodicCalendar: string[];
  /** 感知显示基线已成功过（历史任一次 deliverableCount>0，含 DONE/AWAITING） */
  kpiIdsBootstrapDone: string[];
  /** 近窗内有 stall 告警的 kpiId */
  kpiIdsWithRecentStall: string[];
  /**
   * 可派 repair：近窗 stall 且当前无在途（规则 8）。
   * 仍在途的 stuck 走监督，不并入此项。
   */
  kpiIdsNeedingRepair: string[];
  /** 增量窗口锚点（P3 cursor.sinceAt） */
  sinceAtByKpi: Record<string, string>;
  innerByKpi: Record<string, AdvanceInnerBurstView[]>;
  calendarByKpi: Record<string, AdvanceCalendarCommitmentView[]>;
  stallByKpi: Record<string, AdvanceStallView[]>;
  stallByInstance: Record<string, AdvanceStallView>;
}

export function computeBurstLiveness(
  record: Pick<TaskRecord, 'status' | 'pid' | 'startedAt' | 'lastTickAt' | 'workDir'>,
  now = Date.now(),
): BurstLiveness {
  if (record.status !== 'RUNNING') return null;
  const pidAlive = record.pid != null ? isPidAlive(record.pid) : null;
  if (pidAlive === false) return 'dead';
  const worker = readWorkerStatus(record.workDir);
  const lastTickAt = worker?.lastTickAt ?? record.lastTickAt ?? null;
  const anchor = lastTickAt ?? record.startedAt;
  const sinceAnchor = now - new Date(anchor).getTime();
  return sinceAnchor > STUCK_THRESHOLD_MS ? 'stuck' : 'active';
}

/**
 * 基线是否完成：任一次已有交付物即算（ADL KPI-ADVANCE-WORK-PACKAGE §5）。
 * AWAITING 退出仍可能已写产物；若只认 DONE，日历 ensure 永不触发。
 */
export function isBootstrapDoneFromHistory(history: BurstRunRecord[] | undefined): boolean {
  return (history ?? []).some((run) => (run.deliverableCount ?? 0) > 0);
}

export interface CalendarTaskLike {
  id: string;
  name: string;
  status: string;
  nextRunAt: string | null;
  metadata: Record<string, unknown>;
}

/** 与 StallAlertIndexEntry 对齐的最小形状（避免感知面硬依赖落盘模块） */
export interface StallAlertLike {
  alertId: string;
  instanceId: string;
  severity: 'warn' | 'critical';
  signals: string[];
  summary: string;
  ts: string;
}

export function collectAdvancePerception(opts: {
  tasks: TaskRecord[];
  calendarTasks?: CalendarTaskLike[];
  kpiBootstrapFlags?: Array<{ kpiId: string; bootstrapDone: boolean }>;
  /** P3：cursor.sinceAt */
  sinceAtByKpi?: Record<string, string>;
  stallAlerts?: StallAlertLike[];
  stallMaxAgeMs?: number;
  now?: Date;
}): AdvancePerception {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const innerByKpi: Record<string, AdvanceInnerBurstView[]> = {};
  const kpiIdsWithHealthyRunning: string[] = [];
  const kpiIdsWithUnhealthyRunning: string[] = [];
  const kpiIdsWithInFlight: string[] = [];
  const instanceToKpi = new Map<string, string>();

  for (const task of opts.tasks) {
    const kpiId = task.kpiId?.trim();
    if (kpiId) instanceToKpi.set(task.instanceId, kpiId);
    if (!kpiId) continue;
    const inFlight =
      task.status === 'RUNNING' || task.status === 'AWAITING' || task.status === 'BLOCKED';
    if (!inFlight) continue;

    if (!kpiIdsWithInFlight.includes(kpiId)) kpiIdsWithInFlight.push(kpiId);

    const liveness = computeBurstLiveness(task, nowMs);
    const worker = task.status === 'RUNNING' ? readWorkerStatus(task.workDir) : null;
    const view: AdvanceInnerBurstView = {
      instanceId: task.instanceId,
      kpiId,
      status: task.status,
      liveness,
      lastTickAt: worker?.lastTickAt ?? task.lastTickAt ?? null,
      deliverableCount: task.deliverableCount ?? 0,
    };
    (innerByKpi[kpiId] ??= []).push(view);

    if (task.status === 'RUNNING') {
      if (liveness === 'active') {
        if (!kpiIdsWithHealthyRunning.includes(kpiId)) kpiIdsWithHealthyRunning.push(kpiId);
      } else if (liveness === 'stuck' || liveness === 'dead') {
        if (!kpiIdsWithUnhealthyRunning.includes(kpiId)) kpiIdsWithUnhealthyRunning.push(kpiId);
      }
    }
  }

  const calendarByKpi: Record<string, AdvanceCalendarCommitmentView[]> = {};
  const kpiIdsWithFuturePeriodicCalendar: string[] = [];
  for (const cal of opts.calendarTasks ?? []) {
    if (cal.status !== 'active') continue;
    const kpiId = typeof cal.metadata['kpiId'] === 'string' ? cal.metadata['kpiId'] : undefined;
    if (!kpiId) continue;
    const nextMs = cal.nextRunAt ? Date.parse(cal.nextRunAt) : NaN;
    if (!Number.isFinite(nextMs)) continue;
    const phase: 'due' | 'scheduled' = nextMs <= nowMs ? 'due' : 'scheduled';
    const view: AdvanceCalendarCommitmentView = {
      id: cal.id,
      kpiId,
      title: cal.name,
      phase,
      nextRunAt: cal.nextRunAt,
      expectedOutcome:
        typeof cal.metadata['expectedOutcome'] === 'string'
          ? cal.metadata['expectedOutcome']
          : undefined,
      calendarKey:
        typeof cal.metadata['calendarKey'] === 'string' ? cal.metadata['calendarKey'] : undefined,
    };
    (calendarByKpi[kpiId] ??= []).push(view);
    if (phase === 'scheduled' && !kpiIdsWithFuturePeriodicCalendar.includes(kpiId)) {
      kpiIdsWithFuturePeriodicCalendar.push(kpiId);
    }
  }

  const kpiIdsBootstrapDone = (opts.kpiBootstrapFlags ?? [])
    .filter((row) => row.bootstrapDone)
    .map((row) => row.kpiId);

  const stallMaxAgeMs = opts.stallMaxAgeMs ?? STALL_PERCEPTION_MAX_AGE_MS;
  const stallByInstance: Record<string, AdvanceStallView> = {};
  const stallByKpi: Record<string, AdvanceStallView[]> = {};
  const kpiIdsWithRecentStall: string[] = [];
  // alerts 通常新→旧；同 instance 只取最新一条
  for (const alert of opts.stallAlerts ?? []) {
    const tsMs = Date.parse(alert.ts);
    if (!Number.isFinite(tsMs) || nowMs - tsMs > stallMaxAgeMs) continue;
    if (stallByInstance[alert.instanceId]) continue;
    const kpiId = instanceToKpi.get(alert.instanceId);
    const view: AdvanceStallView = {
      alertId: alert.alertId,
      instanceId: alert.instanceId,
      kpiId,
      severity: alert.severity,
      signals: [...alert.signals],
      summary: alert.summary,
      ts: alert.ts,
    };
    stallByInstance[alert.instanceId] = view;
    if (kpiId) {
      (stallByKpi[kpiId] ??= []).push(view);
      if (!kpiIdsWithRecentStall.includes(kpiId)) kpiIdsWithRecentStall.push(kpiId);
    }
  }

  const kpiIdsNeedingRepair = kpiIdsWithRecentStall.filter(
    (kpiId) =>
      !kpiIdsWithInFlight.includes(kpiId) && !kpiIdsWithHealthyRunning.includes(kpiId),
  );

  const sinceAtByKpi: Record<string, string> = {};
  for (const [kpiId, sinceAt] of Object.entries(opts.sinceAtByKpi ?? {})) {
    if (sinceAt?.trim()) sinceAtByKpi[kpiId] = sinceAt.trim();
  }

  return {
    kpiIdsWithHealthyRunning,
    kpiIdsWithUnhealthyRunning,
    kpiIdsWithInFlight,
    kpiIdsWithFuturePeriodicCalendar,
    kpiIdsBootstrapDone,
    kpiIdsWithRecentStall,
    kpiIdsNeedingRepair,
    sinceAtByKpi,
    innerByKpi,
    calendarByKpi,
    stallByKpi,
    stallByInstance,
  };
}

/**
 * SelfWork 是否应对该 KPI 闭嘴。
 * needingRepair 可突破「基线完成 / 未到期日历」静默（规则 8）。
 */
export function shouldSkipSelfWorkForKpi(perception: AdvancePerception, kpiId: string): boolean {
  if (perception.kpiIdsWithHealthyRunning.includes(kpiId)) return true;
  if (perception.kpiIdsWithInFlight.includes(kpiId)) return true;
  if (perception.kpiIdsNeedingRepair.includes(kpiId)) return false;
  if (perception.kpiIdsWithFuturePeriodicCalendar.includes(kpiId)) return true;
  if (perception.kpiIdsBootstrapDone.includes(kpiId)) return true;
  return false;
}

/** 心跳 / 对话共用的短摘要（禁止靠猜） */
export function formatAdvancePerceptionDigest(perception: AdvancePerception): string {
  const lines: string[] = [];
  if (perception.kpiIdsWithHealthyRunning.length) {
    lines.push(`健康在途 KPI：${perception.kpiIdsWithHealthyRunning.join(', ')}`);
  }
  if (perception.kpiIdsWithUnhealthyRunning.length) {
    lines.push(`不健康 RUNNING KPI：${perception.kpiIdsWithUnhealthyRunning.join(', ')}（监督/reap，勿并行整单）`);
  }
  if (perception.kpiIdsWithFuturePeriodicCalendar.length) {
    lines.push(`未到期周期日历 KPI：${perception.kpiIdsWithFuturePeriodicCalendar.join(', ')}`);
  }
  if (perception.kpiIdsNeedingRepair.length) {
    lines.push(`需 repair KPI：${perception.kpiIdsNeedingRepair.join(', ')}`);
  }
  const stallLines = Object.values(perception.stallByInstance).slice(0, 8).map((s) => {
    const kpi = s.kpiId ? ` kpi=${s.kpiId}` : '';
    return `- ${s.instanceId}${kpi} [${s.severity}] ${s.signals.join('|')}: ${s.summary.slice(0, 120)}`;
  });
  if (stallLines.length) {
    lines.push(`近期 stall：\n${stallLines.join('\n')}`);
  }
  if (!lines.length) return '推进感知：无特殊闸门（无健康在途阻塞 / 无近期 stall）。';
  return `推进感知：\n${lines.join('\n')}`;
}
