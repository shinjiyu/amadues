/**
 * Burst 执行史聚合 — ADL KPI-ADVANCEMENT.md §6
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  BurstRunExitStatus,
  BurstRunRecord,
  KpiRecord,
  KpiRegistry,
  ReflexionSummary,
} from '../kpi-registry.js';
import type { TaskRecord, TaskStatus } from '../inner-brain-registry.js';
import { readReflexionFromWorkspace } from '../kpi-burst-hooks.js';
import { refreshKpiNextDueAt } from './kpi-cadence.js';

export function generateRunId(): string {
  return `run-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

export function mapRegistryStatusToRunExit(
  status: TaskStatus,
  preempted: boolean,
): BurstRunExitStatus {
  if (preempted) return 'PREEMPTED';
  if (status === 'AWAITING') return 'AWAITING';
  if (status === 'ABORTED') return 'ABORTED';
  if (status === 'ERROR') return 'ERROR';
  return 'DONE';
}

export function buildBurstRunRecord(input: {
  kpiId: string;
  instanceId: string;
  charter: string;
  task: TaskRecord;
  exitStatus: BurstRunExitStatus;
  finishedAt?: string;
}): BurstRunRecord {
  const reflexion = readReflexionFromWorkspace(input.task.workDir, input.instanceId);
  const summary: ReflexionSummary | undefined = reflexion ?? undefined;
  return {
    runId: generateRunId(),
    instanceId: input.instanceId,
    kpiId: input.kpiId,
    startedAt: input.task.startedAt,
    finishedAt: input.finishedAt ?? new Date().toISOString(),
    exitStatus: input.exitStatus,
    charter: input.charter.slice(0, 2000),
    ticks: input.task.ticks ?? 0,
    deliverableCount: input.task.deliverableCount ?? 0,
    ...(summary ? { reflexionSummary: summary } : {}),
  };
}

export function formatBurstRunDigest(kpi: KpiRecord, maxRuns = 5): string {
  const runs = kpi.burstRunHistory.slice(-maxRuns);
  if (runs.length === 0) return '（暂无 burst 执行史）';
  const lines = ['## [Burst 执行史]（最近 sprint）'];
  for (const r of runs.reverse()) {
    lines.push(
      `- ${r.finishedAt.slice(0, 16)} exit=${r.exitStatus} ticks=${r.ticks} ` +
        `deliverables=${r.deliverableCount}` +
        (r.reflexionSummary ? ` verdict=${r.reflexionSummary.verdict}` : ''),
    );
    if (r.charter) {
      lines.push(`  charter: ${r.charter.replace(/\s+/g, ' ').slice(0, 120)}…`);
    }
  }
  return lines.join('\n');
}

/** burst onExit：记 run 史 + 刷新 nextDueAt */
export function recordBurstRunOnExit(
  kpiRegistry: KpiRegistry,
  input: {
    kpiId: string;
    instanceId: string;
    task: TaskRecord;
    exitStatus: BurstRunExitStatus;
    charter?: string;
  },
): void {
  const kpi = kpiRegistry.get(input.kpiId);
  if (!kpi) return;
  const charter = input.charter ?? readCharterFromWorkDir(input.task.workDir);
  kpiRegistry.appendBurstRun(
    input.kpiId,
    buildBurstRunRecord({
      kpiId: input.kpiId,
      instanceId: input.instanceId,
      charter,
      task: input.task,
      exitStatus: input.exitStatus,
    }),
  );
  const finishedAt = new Date().toISOString();
  kpiRegistry.update(input.kpiId, {
    lastBurstAt: finishedAt,
    nextDueAt: refreshKpiNextDueAt({ ...kpi, lastBurstAt: finishedAt }),
  });
}

/** 读取本轮 charter（goal.md 首段） */
export function readCharterFromWorkDir(workDir: string): string {
  const goalPath = path.join(workDir, '.brain', 'goal.md');
  if (!fs.existsSync(goalPath)) return '';
  try {
    return fs.readFileSync(goalPath, 'utf8').slice(0, 2000);
  } catch {
    return '';
  }
}
