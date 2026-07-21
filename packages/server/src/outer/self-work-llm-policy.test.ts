import { describe, expect, it, vi } from 'vitest';

import type { KpiRecord } from './kpi-registry.js';
import {
  buildSelfWorkPrompt,
  LlmReflectiveSelfWorkPolicy,
  parseSelfWorkLlmResponse,
} from './self-work-llm-policy.js';
import type { SelfWorkContext, SelfWorkPolicy } from './self-work-policy.js';

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

const fallbackProposal = {
  kpiId: 'kpi-1',
  action: 'fallback 动作',
  expectedOutcome: 'fallback 产出',
  reason: 'fallback',
  strategyId: 'conservative',
};

function fallbackPolicy(): SelfWorkPolicy {
  return { propose: vi.fn().mockResolvedValue(fallbackProposal) };
}

describe('parseSelfWorkLlmResponse', () => {
  it('解析提案 JSON（容忍前后噪声文本）', () => {
    const parsed = parseSelfWorkLlmResponse(
      '好的，我的提案是：\n{"kpiId":"kpi-1","action":"写第三章","expectedOutcome":"3000 字草稿","reason":"推进主线"}\n以上',
    );
    expect(parsed?.sleep).toBe(false);
    expect(parsed?.proposal?.action).toBe('写第三章');
    expect(parsed?.proposal?.strategyId).toBe('llm_reflective');
  });

  it('{"sleep":true} → sleep', () => {
    expect(parseSelfWorkLlmResponse('{"sleep":true}')).toEqual({ sleep: true });
  });

  it('缺字段 / 非 JSON → null', () => {
    expect(parseSelfWorkLlmResponse('{"kpiId":"kpi-1"}')).toBeNull();
    expect(parseSelfWorkLlmResponse('随便聊两句')).toBeNull();
  });
});

describe('LlmReflectiveSelfWorkPolicy', () => {
  it('合法 JSON 提案 → 直接返回（经统一校验）', async () => {
    const policy = new LlmReflectiveSelfWorkPolicy(async () =>
      '{"kpiId":"kpi-1","action":"写第三章","expectedOutcome":"3000 字草稿","reason":"推进主线"}',
    );
    const proposal = await policy.propose(context());
    expect(proposal?.action).toBe('写第三章');
    expect(proposal?.strategyId).toBe('llm_reflective');
  });

  it('{"sleep":true} → 休眠（不走 fallback）', async () => {
    const fallback = fallbackPolicy();
    const policy = new LlmReflectiveSelfWorkPolicy(async () => '{"sleep":true}', fallback);
    expect(await policy.propose(context())).toBeNull();
    expect(fallback.propose).not.toHaveBeenCalled();
  });

  it('解析失败 → fallback', async () => {
    const policy = new LlmReflectiveSelfWorkPolicy(async () => '这不是 JSON', fallbackPolicy());
    const proposal = await policy.propose(context());
    expect(proposal?.strategyId).toBe('conservative');
  });

  it('非法提案（KPI 不存在 / 重复动作）→ fallback', async () => {
    const policy = new LlmReflectiveSelfWorkPolicy(async () =>
      '{"kpiId":"kpi-999","action":"x","expectedOutcome":"y","reason":"z"}',
      fallbackPolicy(),
    );
    expect((await policy.propose(context()))?.strategyId).toBe('conservative');

    const dupPolicy = new LlmReflectiveSelfWorkPolicy(async () =>
      '{"kpiId":"kpi-1","action":"写第三章","expectedOutcome":"y","reason":"z"}',
      fallbackPolicy(),
    );
    const proposal = await dupPolicy.propose(context({ recentActions: ['写第三章'] }));
    expect(proposal?.strategyId).toBe('conservative');
  });

  it('LLM 调用异常 → fallback；无 fallback → null', async () => {
    const boom = async () => {
      throw new Error('503');
    };
    expect(
      (await new LlmReflectiveSelfWorkPolicy(boom, fallbackPolicy()).propose(context()))?.strategyId,
    ).toBe('conservative');
    expect(await new LlmReflectiveSelfWorkPolicy(boom).propose(context())).toBeNull();
  });

  it('无 active KPI → 不调 LLM 直接休眠', async () => {
    const callLlm = vi.fn();
    const policy = new LlmReflectiveSelfWorkPolicy(callLlm);
    expect(await policy.propose(context({ activeKpis: [] }))).toBeNull();
    expect(callLlm).not.toHaveBeenCalled();
  });
});

describe('buildSelfWorkPrompt', () => {
  it('包含 KPI、去重、熔断路线与依赖信息', () => {
    const prompt = buildSelfWorkPrompt(
      context({
        recentActions: ['已做的事'],
        blockedRoutes: ['失败路线'],
        pendingDependencies: ['ib-1:pending-1'],
        runningConflicts: ['在跑的目标'],
      }),
    );
    expect(prompt).toContain('持续创作并运营小说');
    expect(prompt).toContain('已做的事');
    expect(prompt).toContain('失败路线');
    expect(prompt).toContain('ib-1:pending-1');
    expect(prompt).toContain('在跑的目标');
    expect(prompt).toContain('"sleep":true');
  });
});
