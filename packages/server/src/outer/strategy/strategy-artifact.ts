/**
 * 战略规划层 — StrategyArtifact 校验/规范化（ADL STRATEGY-PLANNING-LAYER.md §5/§8/§12）。
 *
 * 守门（缺一即 reject，回退 lastStrategy）：
 *   - WHY 必填：theory + whyNow（只写 HOW 不写 WHY → reject）
 *   - HOW 必填：nextExpectation
 *   - strategy ⊆ registry：activeKpis / focusOrder 与 active 取交集（保 strategy 顺序）
 * 纯函数。
 */
import {
  DEFAULT_REEVALUATE_POLICY,
  DEFAULT_STALE_AWAITING_POLICY,
  type CullDirective,
  type CullGrace,
  type CullReason,
  type StrategyArtifact,
} from './strategy-types.js';

export interface ValidateContext {
  agentId: string;
  /** registry 中 status=active 的 KPI id（用于交集守门） */
  activeKpiIds: string[];
  now?: string;
}

export interface ValidateResult {
  ok: boolean;
  artifact?: StrategyArtifact;
  errors: string[];
}

const CULL_REASONS: CullReason[] = ['kpi_paused', 'kpi_archived', 'strategy_shift', 'belief_expired'];
const CULL_GRACES: CullGrace[] = ['now', 'warn_in_im_then_kill'];

function nonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function validateStrategyArtifact(raw: unknown, ctx: ValidateContext): ValidateResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['artifact_not_object'] };
  }
  const o = raw as Record<string, unknown>;

  // WHY 必填
  if (!nonEmptyStr(o['theory'])) errors.push('missing_why_theory');
  if (!nonEmptyStr(o['whyNow'])) errors.push('missing_why_whyNow');
  // HOW 必填
  if (!nonEmptyStr(o['nextExpectation'])) errors.push('missing_how_nextExpectation');

  // strategy ⊆ registry：focusOrder ∩ active（保 strategy 顺序）
  const activeSet = new Set(ctx.activeKpiIds);
  const focusOrder = strArray(o['focusOrder']).filter((id) => activeSet.has(id));
  // activeKpis：优先用提供的 ∩ active，否则回落 focusOrder
  const declaredActive = strArray(o['activeKpis']).filter((id) => activeSet.has(id));
  const activeKpis = declaredActive.length > 0 ? declaredActive : focusOrder;

  if (errors.length > 0) return { ok: false, errors };

  const pausedKpis = Array.isArray(o['pausedKpis'])
    ? (o['pausedKpis'] as unknown[])
        .map((p) => p as Record<string, unknown>)
        .filter((p) => nonEmptyStr(p['id']))
        .map((p) => ({ id: p['id'] as string, reason: nonEmptyStr(p['reason']) ? (p['reason'] as string) : '' }))
    : [];

  const recentLessons = Array.isArray(o['recentLessons'])
    ? (o['recentLessons'] as unknown[])
        .map((l) => l as Record<string, unknown>)
        .filter((l) => nonEmptyStr(l['takeaway']))
        .map((l) => ({
          burstId: nonEmptyStr(l['burstId']) ? (l['burstId'] as string) : '',
          takeaway: l['takeaway'] as string,
        }))
    : [];

  const cullDirectives: CullDirective[] = Array.isArray(o['cullDirectives'])
    ? (o['cullDirectives'] as unknown[])
        .map((c) => c as Record<string, unknown>)
        .filter(
          (c) =>
            nonEmptyStr(c['burstInstanceId']) &&
            CULL_REASONS.includes(c['reason'] as CullReason) &&
            CULL_GRACES.includes(c['grace'] as CullGrace),
        )
        .map((c) => ({
          burstInstanceId: c['burstInstanceId'] as string,
          reason: c['reason'] as CullReason,
          grace: c['grace'] as CullGrace,
          ...(nonEmptyStr(c['note']) ? { note: c['note'] as string } : {}),
        }))
    : [];

  const sap = (o['staleAwaitingPolicy'] as Record<string, unknown> | undefined) ?? {};
  const staleAwaitingPolicy = {
    maxAwaitingMs:
      typeof sap['maxAwaitingMs'] === 'number' && sap['maxAwaitingMs']! > 0
        ? (sap['maxAwaitingMs'] as number)
        : DEFAULT_STALE_AWAITING_POLICY.maxAwaitingMs,
    requireProgressSignalAfterMs:
      typeof sap['requireProgressSignalAfterMs'] === 'number' && sap['requireProgressSignalAfterMs']! > 0
        ? (sap['requireProgressSignalAfterMs'] as number)
        : DEFAULT_STALE_AWAITING_POLICY.requireProgressSignalAfterMs,
  };

  const rea = (o['reEvaluateAfter'] as Record<string, unknown> | undefined) ?? {};
  const reEvaluateAfter = {
    onBurstExits:
      typeof rea['onBurstExits'] === 'number' && rea['onBurstExits']! >= 1
        ? (rea['onBurstExits'] as number)
        : DEFAULT_REEVALUATE_POLICY.onBurstExits,
    onMs:
      typeof rea['onMs'] === 'number' && rea['onMs']! > 0
        ? (rea['onMs'] as number)
        : DEFAULT_REEVALUATE_POLICY.onMs,
    onEvents: DEFAULT_REEVALUATE_POLICY.onEvents,
  };

  const artifact: StrategyArtifact = {
    version: 1,
    agentId: ctx.agentId,
    updatedAt: ctx.now ?? new Date().toISOString(),
    activeKpis,
    focusOrder,
    pausedKpis,
    theory: (o['theory'] as string).trim(),
    whyNow: (o['whyNow'] as string).trim(),
    recentLessons,
    nextExpectation: (o['nextExpectation'] as string).trim(),
    cullDirectives,
    staleAwaitingPolicy,
    reEvaluateAfter,
  };

  return { ok: true, artifact, errors: [] };
}
