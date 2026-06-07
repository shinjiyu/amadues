/**
 * KPI burst 结果评估 — ADL KPI-BURST-OUTCOME-EVALUATOR.md §3
 */
import type { BurstOutcomeEvaluation, KpiKind } from '../kpi-registry.js';

export type { BurstOutcomeEvaluation };
import { buildBrainAsyncSnapshot } from '../brain-async-snapshot.js';
import { buildBurstProcessReport, type BurstProcessReport } from './burst-process-report.js';

export interface EvaluateKpiBurstOutcomeInput {
  workDir: string;
  dataRoot?: string;
  workspaceId?: string;
  kpiDescription: string;
  kpiKind: KpiKind;
  charter: string;
  exitedWithError: boolean;
  isAwaiting: boolean;
  stoppedBy: string;
  idleStreak: number;
  stuckThreshold?: number;
}

export interface EvaluateKpiBurstOutcomeResult {
  report: BurstProcessReport;
  evaluation: BurstOutcomeEvaluation;
  shouldScheduleRetry: boolean;
}

function collectFailureReasons(
  report: BurstProcessReport,
  exitedWithError: boolean,
  isAwaiting: boolean,
): string[] {
  const reasons: string[] = [];
  if (exitedWithError) reasons.push('子进程异常退出');
  if (report.lastFailure) reasons.push(report.lastFailure);
  for (const line of report.toolLogTail.split('\n')) {
    if (line.startsWith('FAIL ')) reasons.push(`工具失败: ${line.slice(5, 200)}`);
  }
  for (const line of report.nodeResultsSummary.split('\n')) {
    if (line.includes(': failed') || line.includes(': error')) {
      reasons.push(`节点: ${line.replace(/^- /, '').slice(0, 160)}`);
    }
  }
  if (
    !isAwaiting &&
    report.deliverableCount === 0 &&
    !exitedWithError
  ) {
    reasons.push('本轮无登记 deliverable');
  }
  return [...new Set(reasons)].slice(0, 8);
}

function buildRetryCharter(
  kpiDescription: string,
  priorCharter: string,
  failureReasons: string[],
): string {
  const avoid = failureReasons.slice(0, 3).join('；') || '上一轮无产出';
  return (
    `【外脑评估换向重试】\n` +
    `KPI：${kpiDescription.slice(0, 200)}\n` +
    `上一轮问题：${avoid}\n` +
    `要求：避开已失败路径，换可行手段完成一小步；登记 deliverable；不要复述「任务已完成」。\n` +
    (priorCharter.trim() ? `参考章程：${priorCharter.trim().slice(0, 400)}` : '')
  );
}

function buildStuckPivotCharter(
  kpiDescription: string,
  priorCharter: string,
  failureReasons: string[],
): string {
  const avoid = failureReasons.slice(0, 4).join('；') || '多轮无产出';
  return (
    `【外脑卡点换向（idle 达阈值）】\n` +
    `KPI：${kpiDescription.slice(0, 200)}\n` +
    `已撞墙：${avoid}\n` +
    `要求：放弃当前战术假设，换**不同手段或子目标**完成可验证一小步；必须登记 deliverable；禁止重复上轮路径。\n` +
    (priorCharter.trim() ? `勿沿用：${priorCharter.trim().slice(0, 300)}` : '')
  );
}

/** 程序化评估 KPI burst 结果（P0，无 LLM） */
export function evaluateKpiBurstOutcome(
  input: EvaluateKpiBurstOutcomeInput,
): EvaluateKpiBurstOutcomeResult {
  const report = buildBurstProcessReport({
    workDir: input.workDir,
    dataRoot: input.dataRoot,
    workspaceId: input.workspaceId,
  });
  const snap = buildBrainAsyncSnapshot(input.workDir);
  const failureReasons = collectFailureReasons(
    report,
    input.exitedWithError,
    input.isAwaiting,
  );

  let successConfirmed = false;
  let confidence: BurstOutcomeEvaluation['confidence'] = 'medium';

  if (input.isAwaiting && snap.has_ask_user_pending) {
    successConfirmed = false;
    confidence = 'high';
  } else if (input.exitedWithError) {
    successConfirmed = false;
    confidence = 'high';
  } else if (report.deliverableCount >= 1) {
    successConfirmed = true;
    confidence = report.deliverableExcerpt ? 'high' : 'medium';
  } else if (input.isAwaiting) {
    successConfirmed = false;
    confidence = 'medium';
  } else {
    successConfirmed = false;
    confidence = 'high';
  }

  const threshold = input.stuckThreshold ?? 3;
  const reasons =
    failureReasons.length > 0
      ? failureReasons
      : !successConfirmed && report.deliverableCount === 0 && !input.isAwaiting
        ? [`连续 ${input.idleStreak + 1} 次无产出`]
        : failureReasons;
  const canRetry =
    !successConfirmed &&
    !input.isAwaiting &&
    (input.kpiKind !== 'ongoing' || report.deliverableCount === 0);
  const suggestedRetryCharter = canRetry && reasons.length > 0
    ? input.idleStreak >= threshold
      ? buildStuckPivotCharter(input.kpiDescription, input.charter, reasons)
      : buildRetryCharter(input.kpiDescription, input.charter, reasons)
    : undefined;

  const evidenceParts: string[] = [];
  if (report.deliverablePaths.length > 0) {
    evidenceParts.push(`产物: ${report.deliverablePaths.slice(0, 5).join(', ')}`);
  }
  if (failureReasons.length > 0) {
    evidenceParts.push(`疑点: ${failureReasons.slice(0, 3).join('；')}`);
  }

  const evaluation: BurstOutcomeEvaluation = {
    evaluatedAt: new Date().toISOString(),
    successConfirmed,
    confidence,
    failureReasons: reasons,
    evidenceSummary: evidenceParts.join(' | ') || '无产物、无明确失败信号',
    ...(suggestedRetryCharter ? { suggestedRetryCharter } : {}),
    processReportDigest: report.digest.slice(0, 4000),
  };

  return {
    report,
    evaluation,
    shouldScheduleRetry: Boolean(suggestedRetryCharter),
  };
}
