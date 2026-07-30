import type { KpiRecord } from './kpi-registry.js';
import type { AdvancePerception } from './advance-perception.js';
import { shouldSkipSelfWorkForKpi } from './advance-perception.js';
import { buildNarrowDraftProposal } from './advance-allocator.js';

export interface SelfWorkProposal {
  kpiId: string;
  action: string;
  expectedOutcome: string;
  reason: string;
  strategyId: string;
  blockedBy?: string[];
  conflictsWith?: string[];
  /** 确定性再跑：带上则 loop 应 set_goal(burstMode=execute) */
  burstMode?: 'explore' | 'execute';
  workflowRef?: { id: string; version: string };
  /** W15：EW 自优化修订；穿透未到期日历硬闸 */
  purpose?: 'ew_revision';
  evolutionId?: string;
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
  /** 推进感知面（日历 + 内脑）；缺省时跳过感知闸门（兼容旧测） */
  perception?: AdvancePerception;
  /** 可选：为 KPI 查找已晋升 EW → 优先 execute 提案 */
  pickWorkflowRef?: (kpiId: string) => { id: string; version: string } | null;
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

/** Duty 全文 / 旧「推进 KPI：」整单重放检测 */
export function looksLikeDutyReplay(action: string, kpi?: SelfWorkKpi): boolean {
  const a = action.trim();
  if (!a) return false;
  if (kpi?.charter?.trim() && normalized(a) === normalized(kpi.charter)) return true;
  if (a.startsWith('推进 KPI：') && kpi?.description && a.includes(kpi.description.slice(0, 80))) {
    return true;
  }
  // 过长且含「使用方式」+「首次」——典型 Duty 说明书塞进 goal
  if (a.length > 800 && /使用方式|首次|每日定时/.test(a)) return true;
  return false;
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

  const perception = context.perception;
  if (perception) {
    if (perception.kpiIdsWithHealthyRunning.includes(proposal.kpiId)) {
      return { ok: false, reason: 'kpi_has_running_active' };
    }
    if (perception.kpiIdsWithInFlight.includes(proposal.kpiId)) {
      return { ok: false, reason: 'kpi_has_inflight' };
    }
    const isEwRevision = proposal.purpose === 'ew_revision';
    // 未到期日历硬闸：禁止 SelfWork 再派日常 collect；W15 ew_revision 可穿透
    if (
      !isEwRevision &&
      perception.kpiIdsWithFuturePeriodicCalendar.includes(proposal.kpiId)
    ) {
      return { ok: false, reason: 'kpi_has_scheduled_calendar' };
    }
    if (!isEwRevision && perception.kpiIdsBootstrapDone.includes(proposal.kpiId)) {
      if (!perception.kpiIdsNeedingRepair.includes(proposal.kpiId)) {
        return { ok: false, reason: 'kpi_bootstrap_done_await_calendar' };
      }
    }
  }
  if (looksLikeDutyReplay(proposal.action, kpi)) {
    return { ok: false, reason: 'duty_replay_forbidden' };
  }
  if (proposal.burstMode === 'execute') {
    if (!proposal.workflowRef?.id?.trim() || !proposal.workflowRef?.version?.trim()) {
      return { ok: false, reason: 'execute_missing_workflow_ref' };
    }
    const ewRoute = `ew:${proposal.workflowRef.id.trim()}@${String(proposal.workflowRef.version).trim()}`;
    if (isRouteBlocked(ewRoute, context.blockedRoutes)) {
      return { ok: false, reason: 'route_blocked' };
    }
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
      .filter((candidate) =>
        context.perception ? !shouldSkipSelfWorkForKpi(context.perception, candidate.kpiId) : true,
      )
      .sort((a, b) => b.momentum - a.momentum)[0];
    if (!kpi) return null;

    const wfRef = context.pickWorkflowRef?.(kpi.kpiId) ?? null;
    if (wfRef) {
      const executeProposal: SelfWorkProposal = {
        kpiId: kpi.kpiId,
        action:
          `【本轮工作包·execute】按已晋升工作流 ${wfRef.id}@${wfRef.version} 确定性再跑；禁止 redesign / 换路线。`,
        expectedOutcome: `workflow ${wfRef.id}@${wfRef.version} 逐步 expect 全过（.run/workflow_run.json ok）`,
        reason: 'known_executable_workflow',
        strategyId: 'conservative',
        burstMode: 'execute',
        workflowRef: wfRef,
      };
      return validateSelfWorkProposal(executeProposal, context).ok ? executeProposal : null;
    }

    const proposal = buildNarrowDraftProposal(kpi, context.perception, 'conservative');
    if (!proposal) return null;
    return validateSelfWorkProposal(proposal, context).ok ? proposal : null;
  }
}
