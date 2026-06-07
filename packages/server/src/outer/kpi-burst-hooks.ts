/**
 * KPI 与 burst 之间的桥接 hook —— 在 burst 子进程退出时调用。
 *
 * KPI 任务：组装过程报告 → kpiBurstOutcomeEvaluator → burstRunHistory + 可选换向续跑。
 * Ad-hoc（无 kpiId）：仅返回 deliverableCount，由 completionNotify 直给用户。
 *
 * ADL: KPI-BURST-OUTCOME-EVALUATOR.md
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BurstOutcomeEvaluation, KpiRegistry, ReflexionSummary } from './kpi-registry.js';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import { buildBrainAsyncSnapshot } from './brain-async-snapshot.js';
import { recordBurstRunOnExit } from './kpi/burst-run-history.js';
import { mapRegistryStatusToRunExit, readCharterFromWorkDir } from './kpi/burst-run-history.js';
import { evaluateKpiBurstOutcome } from './kpi/kpi-burst-outcome-evaluator.js';
import { shouldAutoAchieveKpi } from './kpi-progress.js';
import { computeMomentumDelta } from './kpi-feedback.js';

/** @deprecated 仅 completion-notify 读历史文件；KPI 评估不再使用 */
export function readReflexionFromWorkspace(
  workDir: string,
  burstInstanceId: string,
): ReflexionSummary | null {
  const p = path.join(workDir, '.brain', 'reflexion.json');
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const verdictRaw = String(raw['verdict'] ?? 'failed').toLowerCase();
    const verdict: ReflexionSummary['verdict'] =
      verdictRaw === 'success' || verdictRaw === 'partial' ? verdictRaw : 'failed';
    return {
      ts: new Date().toISOString(),
      burstInstanceId,
      verdict,
      hardFailures: Array.isArray(raw['hardFailures'])
        ? (raw['hardFailures'] as unknown[]).map(String).slice(0, 10) : [],
      softFailures: Array.isArray(raw['softFailures'])
        ? (raw['softFailures'] as unknown[]).map(String).slice(0, 10) : [],
      nextStrategy: String(raw['nextStrategy'] ?? '').trim(),
    };
  } catch {
    return null;
  }
}

/** 是否应将本次 burst 计为 KPI「无进展」（consecutiveIdleBursts） */
export function shouldRecordKpiIdle(input: {
  exitedWithError: boolean;
  stoppedBy: string;
  deliverableCount: number;
  successConfirmed?: boolean;
  isAwaiting?: boolean;
}): boolean {
  if (input.isAwaiting) return false;
  if (input.successConfirmed) return false;
  if (input.exitedWithError) return input.deliverableCount === 0;
  return input.deliverableCount === 0;
}

/** 读取 deliverables.json 条目数 */
export function countDeliverables(workDir: string): number {
  const p = path.join(workDir, '.run', 'pi-mono', 'deliverables.json');
  try {
    if (!fs.existsSync(p)) return 0;
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

export interface BurstExitInput {
  instanceId: string;
  kpiId?: string;
  /** @deprecated legacy meta burst；新 KPI 路径不再派发 */
  isReflexionBurst?: boolean;
  workDir: string;
  stoppedBy: 'idle' | 'max_ticks' | 'stop_signal' | string;
  exitedWithError: boolean;
  isAwaiting?: boolean;
  dataRoot?: string;
  workspaceId?: string;
}

export interface BurstExitDeps {
  kpiRegistry: KpiRegistry;
  innerBrainRegistry: InnerBrainRegistry;
  scheduleNextKpiBurst?: (kpiId: string, excludeInstanceId?: string) => string | null;
  stuckThreshold?: number;
}

export interface BurstExitOutcome {
  deliverableCount: number;
  /** @deprecated 恒为 null */
  reflexion: ReflexionSummary | null;
  /** @deprecated 恒为 null */
  reflexionBurstId: string | null;
  outcomeEvaluation?: BurstOutcomeEvaluation;
  nextKpiBurstId?: string | null;
  idleStreak: number;
  autoAchieved?: boolean;
  momentum?: number;
}

/**
 * burst 子进程退出后必须调用（KPI 挂接时）。
 */
export function processBurstExitForKpi(
  input: BurstExitInput,
  deps: BurstExitDeps,
): BurstExitOutcome {
  const deliverableCount = countDeliverables(input.workDir);

  if (!input.kpiId) {
    return { deliverableCount, reflexion: null, reflexionBurstId: null, idleStreak: 0 };
  }

  const kpi = deps.kpiRegistry.get(input.kpiId);
  const currentStreak = kpi?.consecutiveIdleBursts ?? 0;
  const threshold = deps.stuckThreshold ?? Math.max(1, Number(process.env['UTLRA_KPI_STUCK_THRESHOLD'] ?? 3));

  const charter = kpi?.charter ?? readCharterFromWorkDir(input.workDir);
  const evalResult = evaluateKpiBurstOutcome({
    workDir: input.workDir,
    dataRoot: input.dataRoot,
    workspaceId: input.workspaceId,
    kpiDescription: kpi?.description ?? '',
    kpiKind: kpi?.kind ?? 'delivery',
    charter,
    exitedWithError: input.exitedWithError,
    isAwaiting: input.isAwaiting ?? false,
    stoppedBy: input.stoppedBy,
    idleStreak: currentStreak,
    stuckThreshold: threshold,
  });

  let streak = currentStreak;
  if (input.isAwaiting) {
    streak = currentStreak;
  } else if (shouldRecordKpiIdle({
    exitedWithError: input.exitedWithError,
    stoppedBy: input.stoppedBy,
    deliverableCount,
    successConfirmed: evalResult.evaluation.successConfirmed,
    isAwaiting: input.isAwaiting,
  })) {
    streak = deps.kpiRegistry.recordIdle(input.kpiId);
  } else {
    deps.kpiRegistry.resetIdle(input.kpiId);
    streak = 0;
  }

  const momentum = deps.kpiRegistry.adjustMomentum(
    input.kpiId,
    computeMomentumDelta({
      verdict: evalResult.evaluation.successConfirmed
        ? 'success'
        : deliverableCount > 0
          ? 'partial'
          : 'failed',
      deliverableCount,
      isAwaiting: input.isAwaiting ?? false,
      exitedWithError: input.exitedWithError,
    }),
  );

  let autoAchieved = false;
  const snap = buildBrainAsyncSnapshot(input.workDir);
  const kpiNow = deps.kpiRegistry.get(input.kpiId);
  if (
    kpiNow?.status === 'active' &&
    shouldAutoAchieveKpi({
      successConfirmed: evalResult.evaluation.successConfirmed,
      deliverableCount,
      isAwaiting: input.isAwaiting ?? false,
      exitedWithError: input.exitedWithError,
      isPostComplete: snap.is_post_complete,
      kind: kpiNow.kind,
    })
  ) {
    deps.kpiRegistry.markAchieved(
      input.kpiId,
      `自动达成：burst ${input.instanceId} 已完成里程碑，产出 ${deliverableCount} 项`,
    );
    autoAchieved = true;
  }

  const taskRec = deps.innerBrainRegistry.get(input.instanceId);
  if (taskRec) {
    const exitStatus = mapRegistryStatusToRunExit(
      input.exitedWithError ? 'ERROR' : input.isAwaiting ? 'AWAITING' : 'DONE',
      false,
    );
    recordBurstRunOnExit(deps.kpiRegistry, {
      kpiId: input.kpiId,
      instanceId: input.instanceId,
      task: {
        ...taskRec,
        deliverableCount,
        ticks: taskRec.ticks,
      },
      exitStatus,
      charter: readCharterFromWorkDir(input.workDir),
      outcomeEvaluation: evalResult.evaluation,
    });
  }

  let nextKpiBurstId: string | null = null;
  const kpiAfter = deps.kpiRegistry.get(input.kpiId);
  if (
    !input.isAwaiting &&
    !autoAchieved &&
    kpiAfter?.status === 'active' &&
    evalResult.shouldScheduleRetry &&
    evalResult.evaluation.suggestedRetryCharter &&
    deps.scheduleNextKpiBurst
  ) {
    deps.kpiRegistry.update(input.kpiId, {
      charter: evalResult.evaluation.suggestedRetryCharter,
    });
    nextKpiBurstId = deps.scheduleNextKpiBurst(input.kpiId, input.instanceId);
  }

  return {
    deliverableCount,
    reflexion: null,
    reflexionBurstId: null,
    outcomeEvaluation: evalResult.evaluation,
    nextKpiBurstId,
    idleStreak: streak,
    autoAchieved,
    momentum,
  };
}
