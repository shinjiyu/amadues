import { describe, expect, it } from 'vitest';

import type { KpiRecord } from './kpi-registry.js';
import {
  ConservativeSelfWorkPolicy,
  validateSelfWorkProposal,
  type SelfWorkContext,
  type SelfWorkProposal,
} from './self-work-policy.js';

function kpi(overrides: Partial<KpiRecord> = {}): KpiRecord {
  return {
    kpiId: 'kpi-1',
    description: '持续创作并运营小说',
    createdBy: 'user',
    createdAt: '2026-07-21T00:00:00.000Z',
    status: 'active',
    kind: 'ongoing',
    momentum: 0,
    bursts: [],
    consecutiveIdleBursts: 0,
    isLeaf: true,
    cadence: { type: 'once' },
    burstRunHistory: [],
    ...overrides,
  };
}

const baseContext: SelfWorkContext = {
  activeKpis: [kpi()],
  pendingDependencies: [],
  runningConflicts: [],
  recentActions: [],
};

describe('validateSelfWorkProposal', () => {
  it('rejects missing outcome, pending dependency, duplicate and conflict', () => {
    const base: SelfWorkProposal = {
      kpiId: 'kpi-1',
      action: '测试发布脚本',
      expectedOutcome: '一份可复现的测试报告',
      reason: '降低发布风险',
      strategyId: 'tooling_first',
    };

    expect(validateSelfWorkProposal({ ...base, expectedOutcome: '' }, baseContext).ok).toBe(false);
    expect(validateSelfWorkProposal(
      { ...base, blockedBy: ['book-title'] },
      { ...baseContext, pendingDependencies: ['book-title'] },
    ).reason).toBe('dependency_unresolved');
    expect(validateSelfWorkProposal(
      base,
      { ...baseContext, recentActions: ['测试发布脚本'] },
    ).reason).toBe('duplicate_action');
    expect(validateSelfWorkProposal(
      { ...base, conflictsWith: ['draft.md'] },
      { ...baseContext, runningConflicts: ['draft.md'] },
    ).reason).toBe('running_conflict');
  });

  it('rejects proposals that retry a circuit-blocked route (R7 route-level)', () => {
    const proposal: SelfWorkProposal = {
      kpiId: 'kpi-1',
      action: '抓取每日行业新闻并生成摘要',
      expectedOutcome: '一份新闻摘要',
      reason: '常态收集',
      strategyId: 'conservative',
    };
    // 被熔断的路线来自 burst goal（工作包模板包含 action 文本，签名互相包含）
    const blocked = `# 数字员工工作包 ## 动作 抓取每日行业新闻并生成摘要 ## 预期产出 …`;
    expect(
      validateSelfWorkProposal(proposal, { ...baseContext, blockedRoutes: [blocked] }).reason,
    ).toBe('route_blocked');
    expect(
      validateSelfWorkProposal(
        { ...proposal, action: '调研竞品定价策略' },
        { ...baseContext, blockedRoutes: [blocked] },
      ).ok,
    ).toBe(true);
  });

  it('does not let one pending ask_user block independent work on the same KPI', () => {
    const proposal: SelfWorkProposal = {
      kpiId: 'kpi-1',
      action: '调研同类小说',
      expectedOutcome: '列出五个可验证的市场观察',
      reason: '不依赖待确认书名',
      strategyId: 'research_first',
    };
    const result = validateSelfWorkProposal(proposal, {
      ...baseContext,
      pendingDependencies: ['book-title'],
    });
    expect(result.ok).toBe(true);
  });
});

describe('ConservativeSelfWorkPolicy', () => {
  it('returns an auditable proposal for an active KPI and sleeps without one', async () => {
    const policy = new ConservativeSelfWorkPolicy();
    const proposal = await policy.propose(baseContext);
    expect(proposal?.kpiId).toBe('kpi-1');
    expect(proposal?.action).toContain('bootstrap');
    expect(proposal?.expectedOutcome.length).toBeGreaterThan(0);
    expect(await policy.propose({ ...baseContext, activeKpis: [] })).toBeNull();
  });

  it('rejects duty-full replay and skips KPI with future calendar perception', async () => {
    const duty: SelfWorkProposal = {
      kpiId: 'kpi-1',
      action: '推进 KPI：持续创作并运营小说 —— 使用方式：首次做 20 条，每日定时……',
      expectedOutcome: 'x',
      reason: 'y',
      strategyId: 'conservative',
    };
    expect(validateSelfWorkProposal(duty, baseContext).reason).toBe('duty_replay_forbidden');

    const policy = new ConservativeSelfWorkPolicy();
    expect(
      await policy.propose({
        ...baseContext,
        perception: {
          kpiIdsWithHealthyRunning: [],
          kpiIdsWithUnhealthyRunning: [],
          kpiIdsWithInFlight: [],
          kpiIdsWithFuturePeriodicCalendar: ['kpi-1'],
          kpiIdsBootstrapDone: [],
          kpiIdsWithRecentStall: [],
          kpiIdsNeedingRepair: [],
          sinceAtByKpi: {},
          innerByKpi: {},
          calendarByKpi: {},
          stallByKpi: {},
          stallByInstance: {},
        },
      }),
    ).toBeNull();
  });
});
