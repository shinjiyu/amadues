/**
 * strategyArtifact 校验单测：WHY+HOW 必填 + strategy⊆active 交集守门。
 * ADL: doc/structurizr/STRATEGY-PLANNING-LAYER.md §5/§8/§12
 */
import { describe, expect, it } from 'vitest';
import { validateStrategyArtifact } from './strategy-artifact.js';

const ctx = { agentId: 'a', activeKpiIds: ['k1', 'k2', 'k3'], now: '2026-06-06T00:00:00.000Z' };

function goodRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    theory: '推进情报收集仍是当前最高价值',
    whyNow: '环境出现新线索，趁热推进',
    nextExpectation: '下一 burst 扩源 2 个新站点',
    focusOrder: ['k2', 'k1'],
    activeKpis: ['k1', 'k2'],
    pausedKpis: [{ id: 'k3', reason: '暂缓' }],
    recentLessons: [{ burstId: 'ib-1', takeaway: 'X 源失效' }],
    cullDirectives: [{ burstInstanceId: 'ib-9', reason: 'strategy_shift', grace: 'now' }],
    ...overrides,
  };
}

describe('validateStrategyArtifact', () => {
  it('合法 → ok，focusOrder 保序', () => {
    const r = validateStrategyArtifact(goodRaw(), ctx);
    expect(r.ok).toBe(true);
    expect(r.artifact?.focusOrder).toEqual(['k2', 'k1']);
    expect(r.artifact?.cullDirectives).toHaveLength(1);
    expect(r.artifact?.staleAwaitingPolicy.maxAwaitingMs).toBeGreaterThan(0);
  });

  it('缺 theory（WHY）→ reject', () => {
    const r = validateStrategyArtifact(goodRaw({ theory: '  ' }), ctx);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('missing_why_theory');
  });

  it('缺 whyNow（WHY）→ reject', () => {
    const r = validateStrategyArtifact(goodRaw({ whyNow: '' }), ctx);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('missing_why_whyNow');
  });

  it('缺 nextExpectation（HOW）→ reject', () => {
    const r = validateStrategyArtifact(goodRaw({ nextExpectation: undefined }), ctx);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('missing_how_nextExpectation');
  });

  it('focusOrder 含非 active id 被过滤（交集守门）', () => {
    const r = validateStrategyArtifact(goodRaw({ focusOrder: ['k1', 'ghost', 'k3'] }), ctx);
    expect(r.artifact?.focusOrder).toEqual(['k1', 'k3']);
  });

  it('非法 cullDirective（坏 reason/grace）被丢弃', () => {
    const r = validateStrategyArtifact(
      goodRaw({ cullDirectives: [{ burstInstanceId: 'x', reason: 'nope', grace: 'now' }] }),
      ctx,
    );
    expect(r.artifact?.cullDirectives).toHaveLength(0);
  });

  it('非对象 → reject', () => {
    expect(validateStrategyArtifact(null, ctx).ok).toBe(false);
    expect(validateStrategyArtifact('x', ctx).ok).toBe(false);
  });
});
