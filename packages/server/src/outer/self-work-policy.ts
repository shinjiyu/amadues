import type { KpiRecord } from './kpi-registry.js';

export interface SelfWorkProposal {
  kpiId: string;
  action: string;
  expectedOutcome: string;
  reason: string;
  strategyId: string;
  blockedBy?: string[];
  conflictsWith?: string[];
}

export type SelfWorkKpi = Pick<
  KpiRecord,
  'kpiId' | 'description' | 'status' | 'notes' | 'charter' | 'momentum'
>;

export interface SelfWorkContext {
  activeKpis: SelfWorkKpi[];
  pendingDependencies: string[];
  runningConflicts: string[];
  recentActions: string[];
  /** R7 路线级熔断：同路线连败 ≥ 阈值的 goal/action 签名，提案命中即拒绝 */
  blockedRoutes?: string[];
}

export interface SelfWorkPolicy {
  propose(context: SelfWorkContext): Promise<SelfWorkProposal | null>;
}

export interface ProposalValidation {
  ok: boolean;
  reason: string;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * 路线签名（R7 路线级熔断）：同一 action 的重试共享同一签名。
 * goal 模板（数字员工工作包）包含 action 文本，因此 goal 签名可与 action 签名互相包含匹配。
 */
export function routeSignature(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ').slice(0, 240);
}

const ROUTE_MATCH_MIN_LENGTH = 8;

/** action 是否命中某条被熔断的路线（双向包含，短文本仅精确匹配防误伤） */
export function isRouteBlocked(action: string, blockedRoutes: string[] = []): boolean {
  const sig = routeSignature(action);
  if (!sig) return false;
  return blockedRoutes.some((route) => {
    const blocked = routeSignature(route);
    if (blocked === sig) return true;
    if (sig.length < ROUTE_MATCH_MIN_LENGTH || blocked.length < ROUTE_MATCH_MIN_LENGTH) return false;
    return blocked.includes(sig) || sig.includes(blocked);
  });
}

function overlaps(left: string[] = [], right: string[] = []): boolean {
  const rightSet = new Set(right.map(normalized));
  return left.some((item) => rightSet.has(normalized(item)));
}

export function validateSelfWorkProposal(
  proposal: SelfWorkProposal,
  context: SelfWorkContext,
): ProposalValidation {
  const kpi = context.activeKpis.find(
    (candidate) => candidate.kpiId === proposal.kpiId && candidate.status === 'active',
  );
  if (!kpi) return { ok: false, reason: 'kpi_not_active' };
  if (!proposal.action.trim()) return { ok: false, reason: 'action_missing' };
  if (!proposal.expectedOutcome.trim()) return { ok: false, reason: 'expected_outcome_missing' };
  if (!proposal.reason.trim()) return { ok: false, reason: 'reason_missing' };
  if (!proposal.strategyId.trim()) return { ok: false, reason: 'strategy_id_missing' };
  if (overlaps(proposal.blockedBy, context.pendingDependencies)) {
    return { ok: false, reason: 'dependency_unresolved' };
  }
  if (overlaps(proposal.conflictsWith, context.runningConflicts)) {
    return { ok: false, reason: 'running_conflict' };
  }
  if (context.recentActions.some((action) => normalized(action) === normalized(proposal.action))) {
    return { ok: false, reason: 'duplicate_action' };
  }
  if (isRouteBlocked(proposal.action, context.blockedRoutes)) {
    return { ok: false, reason: 'route_blocked' };
  }
  return { ok: true, reason: 'proposal_valid' };
}

/**
 * P0 deterministic policy. It deliberately proposes one bounded work package and
 * can be replaced by research/tooling/balanced/LLM policies without changing the loop.
 */
export class ConservativeSelfWorkPolicy implements SelfWorkPolicy {
  async propose(context: SelfWorkContext): Promise<SelfWorkProposal | null> {
    const kpi = [...context.activeKpis]
      .filter((candidate) => candidate.status === 'active')
      .sort((a, b) => b.momentum - a.momentum)[0];
    if (!kpi) return null;

    const action = kpi.charter?.trim() || `推进 KPI：${kpi.description}`;
    const proposal: SelfWorkProposal = {
      kpiId: kpi.kpiId,
      action,
      expectedOutcome: `产出可验收结果并记录其对“${kpi.description}”的推进证据`,
      reason: kpi.notes?.trim() || '当前有可用容量，优先推进最高反馈的 active KPI',
      strategyId: 'conservative',
    };
    return validateSelfWorkProposal(proposal, context).ok ? proposal : null;
  }
}
