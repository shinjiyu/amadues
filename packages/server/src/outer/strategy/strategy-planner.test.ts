/**
 * strategyPlanner 单测：FakeLLM → 合法 artifact / reject→fallback / 解析容错。
 * ADL: doc/structurizr/STRATEGY-PLANNING-LAYER.md §2b/§5/§12
 */
import { describe, expect, it } from 'vitest';
import { buildFallbackArtifact, extractJsonObject, planNext } from './strategy-planner.js';
import type { StrategyPlanInput } from './strategy-types.js';

function input(overrides: Partial<StrategyPlanInput> = {}): StrategyPlanInput {
  return {
    agentId: 'a',
    kpis: [
      { id: 'k1', title: '台湾情报', status: 'active', momentum: 3 },
      { id: 'k2', title: '日本情报', status: 'active', momentum: 1 },
    ],
    recentBursts: [{ instanceId: 'ib-1', kpiId: 'k1', state: 'DONE' }],
    envEvents: [],
    lastStrategy: null,
    ...overrides,
  };
}

const NOW = () => Date.parse('2026-06-06T00:00:00.000Z');

describe('extractJsonObject', () => {
  it('剥离 ```json 围栏', () => {
    expect(extractJsonObject('前言\n```json\n{"a":1}\n```\n后语')).toEqual({ a: 1 });
  });
  it('裸 JSON', () => {
    expect(extractJsonObject('{"a":2} trailing')).toEqual({ a: 2 });
  });
  it('无 JSON → null', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });
});

describe('planNext', () => {
  it('合法 LLM 输出 → 有效 artifact（不 reject）', async () => {
    const llm = async () =>
      JSON.stringify({
        theory: '情报收集仍是最高价值',
        whyNow: '有新线索',
        nextExpectation: '扩源',
        focusOrder: ['k2', 'k1'],
      });
    const r = await planNext(input(), { callLlm: llm, now: NOW });
    expect(r.rejected).toBe(false);
    expect(r.artifact.focusOrder).toEqual(['k2', 'k1']);
  });

  it('缺 WHY（whyNow）→ reject + fallback（首次按 momentum 排）', async () => {
    const llm = async () => JSON.stringify({ theory: 't', nextExpectation: 'n', focusOrder: ['k1'] });
    const r = await planNext(input(), { callLlm: llm, now: NOW });
    expect(r.rejected).toBe(true);
    expect(r.rejectErrors).toContain('missing_why_whyNow');
    // fallback：无 lastStrategy → 按 momentum 降序 k1(3) > k2(1)
    expect(r.artifact.focusOrder).toEqual(['k1', 'k2']);
  });

  it('LLM 抛错 → fallback（复用 lastStrategy 交集）', async () => {
    const last = {
      version: 1 as const, agentId: 'a', updatedAt: 'old',
      activeKpis: ['k1'], focusOrder: ['k1', 'gone'], pausedKpis: [],
      theory: 'last-t', whyNow: 'last-w', recentLessons: [], nextExpectation: 'last-n',
      cullDirectives: [], staleAwaitingPolicy: { maxAwaitingMs: 1, requireProgressSignalAfterMs: 1 },
      reEvaluateAfter: { onBurstExits: 1, onMs: 1, onEvents: [] as never[] },
    };
    const llm = async () => { throw new Error('boom'); };
    const r = await planNext(input({ lastStrategy: last }), { callLlm: llm, now: NOW });
    expect(r.rejected).toBe(true);
    expect(r.rejectErrors[0]).toMatch(/llm_error/);
    // 复用 last，但 'gone' 非 active 被剔除
    expect(r.artifact.focusOrder).toEqual(['k1']);
    expect(r.artifact.theory).toBe('last-t');
  });

  it('垃圾输出 → reject(parse_failed) + fallback', async () => {
    const r = await planNext(input(), { callLlm: async () => 'totally not json', now: NOW });
    expect(r.rejected).toBe(true);
    expect(r.rejectErrors).toContain('parse_failed');
  });
});

describe('buildFallbackArtifact', () => {
  it('无 last → 按 momentum 排 active', () => {
    const a = buildFallbackArtifact(input(), ['k1', 'k2'], '2026-06-06T00:00:00.000Z');
    expect(a.focusOrder).toEqual(['k1', 'k2']);
    expect(a.cullDirectives).toHaveLength(0);
  });
});
