/**
 * EW execute 质检（W15）— 机械 ok + 产物登记/非空。
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §6.2
 */
import fs from 'node:fs';
import path from 'node:path';

import { ensureAllowlistedEwDeliverables } from './ew-deliverable-allowlist.js';

export interface WorkflowOutcomeEvaluation {
  okMechanical: boolean;
  okQuality: boolean;
  needsEvolution: boolean;
  reasons: string[];
  signature: string;
  deliverableCount: number;
  workflowId?: string;
  version?: string;
}

function readWorkflowRun(workDir: string): {
  ok?: boolean;
  workflowId?: string;
  version?: string;
  abortedAt?: string;
  steps?: Array<{ ok?: boolean; detail?: string; stepId?: string }>;
} | null {
  const fp = path.join(workDir, '.run', 'workflow_run.json');
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as {
      ok?: boolean;
      workflowId?: string;
      version?: string;
      abortedAt?: string;
      steps?: Array<{ ok?: boolean; detail?: string; stepId?: string }>;
    };
  } catch {
    return null;
  }
}

function countRegisteredDeliverables(workDir: string, paths: string[]): number {
  let n = 0;
  for (const rel of paths) {
    const abs = path.join(workDir, rel);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size > 0) n += 1;
    } catch {
      /* skip */
    }
  }
  return n;
}

/**
 * 评估一次 EW execute 工作区。
 * - 无 workflow_run → 需要进化（未留下可复跑迹）
 * - ok=false → 需要进化
 * - ok=true 但无登记产物 / 产物空 → 需要进化（假绿）
 */
export function evaluateWorkflowOutcome(workDir: string): WorkflowOutcomeEvaluation {
  const reasons: string[] = [];
  const run = readWorkflowRun(workDir);
  if (!run) {
    return {
      okMechanical: false,
      okQuality: false,
      needsEvolution: true,
      reasons: ['missing_workflow_run'],
      signature: 'missing_workflow_run',
      deliverableCount: 0,
    };
  }

  const okMechanical = run.ok === true;
  if (!okMechanical) {
    const failed = (run.steps ?? []).find((s) => s.ok === false);
    reasons.push(
      failed?.detail?.trim()
        ? `step_failed:${failed.stepId ?? '?'}:${failed.detail.slice(0, 120)}`
        : run.abortedAt
          ? `aborted:${run.abortedAt}`
          : 'workflow_run_ok_false',
    );
  }

  const registered = ensureAllowlistedEwDeliverables(workDir);
  const deliverableCount = countRegisteredDeliverables(workDir, registered);
  if (okMechanical && deliverableCount === 0) {
    reasons.push('no_registered_deliverables');
  }

  // 假绿：summary json 宣称 kept_count=0 且 md 只有空窗提示 —— 不算失败（合法空窗）
  // 假绿：ok 但 deliverables.json 未登记却有文件 —— allowlist 已补登；仍 0 才进化

  const okQuality = okMechanical && deliverableCount > 0;
  const needsEvolution = !okQuality;
  const signature = (reasons[0] ?? (okQuality ? 'ok' : 'unknown')).slice(0, 160);

  return {
    okMechanical,
    okQuality,
    needsEvolution,
    reasons,
    signature,
    deliverableCount,
    workflowId: typeof run.workflowId === 'string' ? run.workflowId : undefined,
    version: run.version != null ? String(run.version) : undefined,
  };
}
