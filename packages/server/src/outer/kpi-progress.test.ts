/**
 * KPI 进展推断单元测试：`shouldAutoAchieveKpi` + `suggestKpiAction` 全分支。
 *
 * 这两个纯函数决定外脑「下一步要不要自动 achieve / 派反思 / 等 / 继续」。
 * 任何一个分支退化都会让外脑陷入"完成不收尾"或"卡住不反思"的死循环。
 */
import { describe, expect, it } from 'vitest';

import {
  shouldAutoAchieveKpi,
  suggestKpiAction,
  type KpiBurstLink,
} from './kpi-progress.js';
import type { KpiRecord, ReflexionSummary } from './kpi-registry.js';

function makeKpi(overrides: Partial<KpiRecord> = {}): KpiRecord {
  return {
    kpiId: 'kpi-test',
    description: 'test kpi',
    createdBy: 'test:user',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    bursts: [],
    consecutiveIdleBursts: 0,
    reflexionTrail: [],
    ...overrides,
  };
}

function makeLink(overrides: Partial<KpiBurstLink> = {}): KpiBurstLink {
  return {
    instanceId: 'ib-1',
    registryStatus: 'DONE',
    isPostComplete: false,
    isAsyncWaiting: false,
    hasAskUserPending: false,
    deliverableCount: 0,
    lastReflexionVerdict: null,
    ...overrides,
  };
}

const successReflexion: ReflexionSummary = {
  ts: '2026-01-01T00:00:00.000Z',
  burstInstanceId: 'ib-x',
  verdict: 'success',
  hardFailures: [],
  softFailures: [],
  nextStrategy: '',
};

// ──────────────────────────────────────────────────────────────────────────────
// shouldAutoAchieveKpi
// ──────────────────────────────────────────────────────────────────────────────

describe('shouldAutoAchieveKpi', () => {
  it('post-complete + deliverables + success → true', () => {
    expect(
      shouldAutoAchieveKpi({
        reflexion: successReflexion,
        deliverableCount: 2,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: true,
      }),
    ).toBe(true);
  });

  it('未完成里程碑 → false', () => {
    expect(
      shouldAutoAchieveKpi({
        reflexion: successReflexion,
        deliverableCount: 2,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: false,
      }),
    ).toBe(false);
  });

  it('AWAITING → false', () => {
    expect(
      shouldAutoAchieveKpi({
        reflexion: successReflexion,
        deliverableCount: 1,
        isAwaiting: true,
        exitedWithError: false,
        isPostComplete: true,
      }),
    ).toBe(false);
  });

  it('exitedWithError → false', () => {
    expect(
      shouldAutoAchieveKpi({
        reflexion: successReflexion,
        deliverableCount: 1,
        isAwaiting: false,
        exitedWithError: true,
        isPostComplete: true,
      }),
    ).toBe(false);
  });

  it('partial verdict 也接受', () => {
    expect(
      shouldAutoAchieveKpi({
        reflexion: { ...successReflexion, verdict: 'partial' },
        deliverableCount: 1,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: true,
      }),
    ).toBe(true);
  });

  it('reflexion 缺失 → 仍按其它条件判定（true）', () => {
    expect(
      shouldAutoAchieveKpi({
        reflexion: null,
        deliverableCount: 1,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: true,
      }),
    ).toBe(true);
  });

  it('verdict=failed → false（避免把失败 burst 当成达成）', () => {
    expect(
      shouldAutoAchieveKpi({
        reflexion: { ...successReflexion, verdict: 'failed' },
        deliverableCount: 2,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: true,
      }),
    ).toBe(false);
  });

  it('post-complete 但无 deliverable → false', () => {
    expect(
      shouldAutoAchieveKpi({
        reflexion: successReflexion,
        deliverableCount: 0,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: true,
      }),
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// suggestKpiAction
// ──────────────────────────────────────────────────────────────────────────────

describe('suggestKpiAction · 终态优先', () => {
  it('status=achieved → action=achieved', () => {
    const kpi = makeKpi({ status: 'achieved' });
    expect(suggestKpiAction(kpi, []).action).toBe('achieved');
  });

  it('status=abandoned → action=achieved（终态归一）', () => {
    const kpi = makeKpi({ status: 'abandoned' });
    expect(suggestKpiAction(kpi, []).action).toBe('achieved');
  });

  it('status=paused → action=continue', () => {
    expect(suggestKpiAction(makeKpi({ status: 'paused' }), []).action).toBe('continue');
  });
});

describe('suggestKpiAction · active 状态', () => {
  it('最近 burst DONE+post_complete+有产出+success → achieved', () => {
    const link = makeLink({
      registryStatus: 'DONE',
      isPostComplete: true,
      deliverableCount: 2,
      lastReflexionVerdict: 'success',
    });
    expect(suggestKpiAction(makeKpi(), [link]).action).toBe('achieved');
  });

  it('最近 burst DONE+post_complete+有产出+无反思 verdict → 仍 achieved', () => {
    const link = makeLink({
      registryStatus: 'DONE',
      isPostComplete: true,
      deliverableCount: 1,
      lastReflexionVerdict: null,
    });
    expect(suggestKpiAction(makeKpi(), [link]).action).toBe('achieved');
  });

  it('有 burst 在 async waiting + ask_user → awaiting_human', () => {
    const link = makeLink({
      isAsyncWaiting: true,
      hasAskUserPending: true,
      registryStatus: 'AWAITING',
    });
    const r = suggestKpiAction(makeKpi(), [link]);
    expect(r.action).toBe('awaiting_human');
    expect(r.reason).toMatch(/人类|ask_user/);
  });

  it('有 burst 在 async waiting 但无 ask_user → follow_up', () => {
    const link = makeLink({ isAsyncWaiting: true, registryStatus: 'AWAITING' });
    const r = suggestKpiAction(makeKpi(), [link]);
    expect(r.action).toBe('follow_up');
    expect(r.reason).toMatch(/阻塞|外部/);
  });

  it('有 burst BLOCKED 且未交付 → follow_up', () => {
    const link = makeLink({ registryStatus: 'BLOCKED' });
    expect(suggestKpiAction(makeKpi(), [link]).action).toBe('follow_up');
  });

  it('idle streak 达阈值 → stuck_reflexion', () => {
    const kpi = makeKpi({ consecutiveIdleBursts: 3 });
    expect(suggestKpiAction(kpi, [], 3).action).toBe('stuck_reflexion');
  });

  it('idle streak 超阈值 → stuck_reflexion（reason 含次数）', () => {
    const kpi = makeKpi({ consecutiveIdleBursts: 5 });
    const r = suggestKpiAction(kpi, [], 3);
    expect(r.action).toBe('stuck_reflexion');
    expect(r.reason).toContain('5');
  });

  it('有 burst RUNNING → continue', () => {
    const link = makeLink({ registryStatus: 'RUNNING' });
    expect(suggestKpiAction(makeKpi(), [link]).action).toBe('continue');
  });

  it('idle streak > 0 且未到阈值 → continue（由 onExit 达阈值再派 meta）', () => {
    const kpi = makeKpi({ consecutiveIdleBursts: 1 });
    expect(suggestKpiAction(kpi, [], 3).action).toBe('continue');
  });

  it('完全活跃推进（无产出 / 无等待 / 无 idle）→ continue', () => {
    expect(suggestKpiAction(makeKpi(), []).action).toBe('continue');
  });
});

describe('suggestKpiAction · 排序与优先级', () => {
  it('终态优先于 streak（即使 idle=99 也不再 stuck_reflexion）', () => {
    const kpi = makeKpi({ status: 'achieved', consecutiveIdleBursts: 99 });
    expect(suggestKpiAction(kpi, []).action).toBe('achieved');
  });

  it('awaiting_human 优先于 stuck_reflexion（等用户时不应自驱反思）', () => {
    const kpi = makeKpi({ consecutiveIdleBursts: 5 });
    const link = makeLink({
      isAsyncWaiting: true,
      hasAskUserPending: true,
      registryStatus: 'AWAITING',
    });
    expect(suggestKpiAction(kpi, [link], 3).action).toBe('awaiting_human');
  });

  it('历史 DONE+AWAITING 不触发 follow_up（仅看在途 burst）', () => {
    const doneStaleAwaiting = makeLink({
      instanceId: 'ib-old',
      registryStatus: 'DONE',
      isAsyncWaiting: true,
    });
    expect(suggestKpiAction(makeKpi(), [doneStaleAwaiting]).action).toBe('continue');
  });

  it('achieved 优先于 follow_up（只要最近 burst 已收尾）', () => {
    const olderAwaiting = makeLink({
      instanceId: 'ib-0',
      registryStatus: 'AWAITING',
      isAsyncWaiting: true,
    });
    const recentDone = makeLink({
      instanceId: 'ib-1',
      registryStatus: 'DONE',
      isPostComplete: true,
      deliverableCount: 1,
      lastReflexionVerdict: 'success',
    });
    // links 中"最新 burst"是 array 末尾，achieved 触发；旧 AWAITING 不算
    expect(suggestKpiAction(makeKpi(), [olderAwaiting, recentDone]).action).toBe('achieved');
  });
});
