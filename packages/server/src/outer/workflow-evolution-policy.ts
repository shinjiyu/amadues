/**
 * EW 自优化策略（W15）：settle 记提案；SelfWork 优先 explore 修订。
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §6.2
 */
import { appendAutonomyActionLog } from './autonomy-action-log.js';
import {
  listEvolutionProposals,
  markEvolutionStatus,
  upsertPendingEvolution,
  type WorkflowEvolutionProposal,
} from './workflow-evolution-store.js';
import { evaluateWorkflowOutcome } from './workflow-outcome-evaluator.js';
import type { SelfWorkContext, SelfWorkPolicy, SelfWorkProposal } from './self-work-policy.js';
import { validateSelfWorkProposal } from './self-work-policy.js';

export function buildEwRevisionCharter(input: {
  workflowId: string;
  version: string;
  reasons: string[];
}): string {
  const why = input.reasons.join('；') || '质检未通过';
  return [
    `【EW 修订 ew_revision】base=${input.workflowId}@${input.version}`,
    `问题：${why}`,
    '目标：在本 workspace explore 修好脚本/步骤/expect 后，调用 promote_executable_workflow：',
    `- workflow_id 必须仍是 ${input.workflowId}（同 id bump version，禁止另起无关 id）`,
    `- 传 base_workflow_id=${input.workflowId}、base_workflow_version=${input.version}`,
    '- 保留原 kpi: / role:collect|primary 标签；补齐产物登记与时间窗等契约缺口',
    '禁止：只聊天不晋升；禁止 execute 静默改 EW 正文。',
  ].join('\n');
}

export function evolutionToSelfWorkProposal(
  evo: WorkflowEvolutionProposal,
): SelfWorkProposal | null {
  if (!evo.kpiId?.trim()) return null;
  return {
    kpiId: evo.kpiId,
    action: evo.charter,
    expectedOutcome: `已 promote ${evo.workflowId}@>${evo.version}（质检可过、产物已登记）`,
    reason: `ew_evolution:${evo.signature}`,
    strategyId: 'workflow_evolution',
    burstMode: 'explore',
    purpose: 'ew_revision',
    evolutionId: evo.id,
  };
}

/**
 * execute settle 后调用：不合格则写入 pending 提案（不 spawn）。
 */
export function considerWorkflowEvolution(opts: {
  dataRoot: string;
  workDir: string;
  instanceId?: string;
  kpiId?: string;
  workflowId?: string;
  version?: string;
}): WorkflowEvolutionProposal | null {
  const outcome = evaluateWorkflowOutcome(opts.workDir);
  if (!outcome.needsEvolution) return null;

  const workflowId = opts.workflowId?.trim() || outcome.workflowId?.trim();
  const version = opts.version?.trim() || outcome.version?.trim();
  if (!workflowId || !version) return null;

  const charter = buildEwRevisionCharter({
    workflowId,
    version,
    reasons: outcome.reasons,
  });
  const { proposal, created } = upsertPendingEvolution(opts.dataRoot, {
    workflowId,
    version,
    kpiId: opts.kpiId,
    signature: outcome.signature,
    reasons: outcome.reasons,
    charter,
    sourceInstanceId: opts.instanceId,
    sourceWorkDir: opts.workDir,
  });

  appendAutonomyActionLog(opts.dataRoot, {
    at: new Date().toISOString(),
    dispatched: false,
    reason: created ? 'workflow_evolution:pending' : 'workflow_evolution:dedup',
    detail: `${proposal.workflowId}@${proposal.version} ${proposal.signature} kpi=${proposal.kpiId ?? '-'}`,
  });
  return proposal;
}

/**
 * 包装既有 SelfWorkPolicy：优先消费 pending ew_revision。
 */
export class WorkflowEvolutionSelfWorkPolicy implements SelfWorkPolicy {
  constructor(
    private readonly dataRoot: string,
    private readonly inner: SelfWorkPolicy,
  ) {}

  async propose(context: SelfWorkContext): Promise<SelfWorkProposal | null> {
    const pending = listEvolutionProposals(this.dataRoot, 'pending');
    const active = new Set(
      context.activeKpis.filter((k) => k.status === 'active').map((k) => k.kpiId),
    );
    for (const evo of pending) {
      if (!evo.kpiId || !active.has(evo.kpiId)) continue;
      const proposal = evolutionToSelfWorkProposal(evo);
      if (!proposal) continue;
      if (validateSelfWorkProposal(proposal, context).ok) return proposal;
    }
    return this.inner.propose(context);
  }
}

export function markEvolutionDispatched(dataRoot: string, evolutionId: string): void {
  markEvolutionStatus(dataRoot, evolutionId, 'dispatched');
}
