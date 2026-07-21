import { describe, expect, it } from 'vitest';

import type { KpiRecord } from './kpi-registry.js';
import { summarizeSelfWorkMetrics, type SelfWorkMetricEvent } from './self-work-metrics.js';
import type { SelfWorkContext } from './self-work-policy.js';
import {
  AbTestSelfWorkPolicy,
  createSelfWorkPolicy,
  createSelfWorkStrategy,
  SELF_WORK_STRATEGY_IDS,
} from './self-work-strategies.js';

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

function context(overrides: Partial<SelfWorkContext> = {}): SelfWorkContext {
  return {
    activeKpis: [kpi()],
    pendingDependencies: [],
    runningConflicts: [],
    recentActions: [],
    ...overrides,
  };
}

describe('createSelfWorkStrategy', () => {
  it('同一 fixture 下各策略输出可比较提案（P2 创造性实验）', async () => {
    const ctx = context();
    const byStrategy: Record<string, string> = {};
    for (const id of SELF_WORK_STRATEGY_IDS) {
      const proposal = await createSelfWorkStrategy(id).propose(ctx);
      expect(proposal, id).not.toBeNull();
      expect(proposal!.strategyId).toBe(id);
      expect(proposal!.expectedOutcome.length).toBeGreaterThan(0);
      byStrategy[id] = proposal!.action;
    }
    expect(byStrategy['research_first']).toContain('调研');
    expect(byStrategy['tooling_first']).toContain('自动化');
    expect(byStrategy['research_first']).not.toBe(byStrategy['conservative']);
  });

  it('首选角度重复时换下一角度而非休眠', async () => {
    const policy = createSelfWorkStrategy('research_first');
    const first = await policy.propose(context());
    const next = await policy.propose(context({ recentActions: [first!.action] }));
    expect(next).not.toBeNull();
    expect(next!.action).not.toBe(first!.action);
  });

  it('路线被熔断时换独立方向（P2 R7 收窄）', async () => {
    const policy = createSelfWorkStrategy('balanced');
    const first = await policy.propose(context());
    const next = await policy.propose(context({ blockedRoutes: [first!.action] }));
    expect(next).not.toBeNull();
    expect(next!.action).not.toBe(first!.action);
  });

  it('无 active KPI / 全部角度耗尽 → null 休眠', async () => {
    const policy = createSelfWorkStrategy('conservative');
    expect(await policy.propose(context({ activeKpis: [] }))).toBeNull();
    const only = await policy.propose(context());
    expect(
      await policy.propose(context({ recentActions: [only!.action] })),
    ).toBeNull();
  });

  it('balanced 按 recentActions 轮换起始角度', async () => {
    const policy = createSelfWorkStrategy('balanced');
    const round0 = await policy.propose(context());
    const round1 = await policy.propose(context({ recentActions: ['其他动作'] }));
    expect(round0!.action).not.toBe(round1!.action);
  });
});

function metricEvents(
  rows: Array<{ strategyId: string; kind: 'accepted' | 'rejected'; n: number }>,
): SelfWorkMetricEvent[] {
  return rows.flatMap((row) =>
    Array.from({ length: row.n }, () => ({
      at: '2026-07-21T00:00:00.000Z',
      kind: row.kind,
      reason: row.kind === 'accepted' ? 'self_work_dispatched' : 'duplicate_action',
      strategyId: row.strategyId,
    })),
  );
}

describe('AbTestSelfWorkPolicy（P3 灰度）', () => {
  it('探索期：优先选试次最少且未满 minTrials 的候选', () => {
    const summary = summarizeSelfWorkMetrics(
      metricEvents([
        { strategyId: 'conservative', kind: 'accepted', n: 3 },
        { strategyId: 'balanced', kind: 'accepted', n: 1 },
      ]),
    );
    const policy = new AbTestSelfWorkPolicy({
      candidates: ['conservative', 'balanced'],
      getSummary: () => summary,
      minTrialsPerStrategy: 3,
    });
    expect(policy.pick()).toBe('balanced');
  });

  it('利用期：全部试满后按 acceptance rate 选最优', () => {
    const summary = summarizeSelfWorkMetrics(
      metricEvents([
        { strategyId: 'conservative', kind: 'accepted', n: 1 },
        { strategyId: 'conservative', kind: 'rejected', n: 3 },
        { strategyId: 'balanced', kind: 'accepted', n: 3 },
        { strategyId: 'balanced', kind: 'rejected', n: 1 },
      ]),
    );
    const policy = new AbTestSelfWorkPolicy({
      candidates: ['conservative', 'balanced'],
      getSummary: () => summary,
      minTrialsPerStrategy: 3,
    });
    expect(policy.pick()).toBe('balanced');
  });

  it('被选策略 null 时回退其余候选；strategyId 保留真实归因', async () => {
    // conservative 只有 draft 角度；recentActions 命中 draft → conservative 休眠，
    // 回退 research_first 仍能提研究角度
    const summary = summarizeSelfWorkMetrics([]);
    const policy = new AbTestSelfWorkPolicy({
      candidates: ['conservative', 'research_first'],
      getSummary: () => summary,
      minTrialsPerStrategy: 1,
    });
    const draft = await createSelfWorkStrategy('conservative').propose(context());
    const proposal = await policy.propose(context({ recentActions: [draft!.action] }));
    expect(proposal).not.toBeNull();
    expect(proposal!.strategyId).toBe('research_first');
  });
});

describe('createSelfWorkPolicy（spec 解析）', () => {
  const opts = { getSummary: () => summarizeSelfWorkMetrics([]) };

  it('单策略 id / ab / ab:列表 / 非法输入', async () => {
    expect(createSelfWorkPolicy('balanced', opts).spec).toBe('balanced');
    expect(createSelfWorkPolicy('ab', opts).spec).toBe(`ab:${SELF_WORK_STRATEGY_IDS.join(',')}`);
    expect(createSelfWorkPolicy('ab:conservative,balanced', opts).spec).toBe(
      'ab:conservative,balanced',
    );
    expect(createSelfWorkPolicy('nonsense', opts).spec).toBe('conservative');
  });

  it('llm_reflective 无 caller → 降级 conservative；有 caller → 生效', async () => {
    expect(createSelfWorkPolicy('llm_reflective', opts).spec).toBe('conservative');
    const resolved = createSelfWorkPolicy('llm_reflective', {
      ...opts,
      llmCaller: async () => '{"sleep":true}',
    });
    expect(resolved.spec).toBe('llm_reflective');
    expect(await resolved.policy.propose(context())).toBeNull();
  });
});
