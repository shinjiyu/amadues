/**
 * KPI 进展推断单元测试：`shouldAutoAchieveKpi` + `suggestKpiAction` 全分支。
 */
import { describe, expect, it } from 'vitest';

import {
  shouldAutoAchieveKpi,
  suggestKpiAction,
  type KpiBurstLink,
} from './kpi-progress.js';
import type { KpiRecord } from './kpi-registry.js';

function makeKpi(overrides: Partial<KpiRecord> = {}): KpiRecord {
  return {
    kpiId: 'kpi-test',
    description: 'test kpi',
    createdBy: 'test:user',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    kind: 'delivery',
    momentum: 0,
    bursts: [],
    consecutiveIdleBursts: 0,
    isLeaf: true,
    cadence: { type: 'once' },
    burstRunHistory: [],
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
    lastOutcomeSuccess: null,
    ...overrides,
  };
}

describe('shouldAutoAchieveKpi', () => {
  it('post-complete + deliverables + successConfirmed → true', () => {
    expect(
      shouldAutoAchieveKpi({
        successConfirmed: true,
        deliverableCount: 2,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: true,
      }),
    ).toBe(true);
  });

  it('successConfirmed=false → false', () => {
    expect(
      shouldAutoAchieveKpi({
        successConfirmed: false,
        deliverableCount: 2,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: true,
      }),
    ).toBe(false);
  });

  it('未完成里程碑 → false', () => {
    expect(
      shouldAutoAchieveKpi({
        successConfirmed: true,
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
        successConfirmed: true,
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
        successConfirmed: true,
        deliverableCount: 1,
        isAwaiting: false,
        exitedWithError: true,
        isPostComplete: true,
      }),
    ).toBe(false);
  });

  it('post-complete 但无 deliverable → false', () => {
    expect(
      shouldAutoAchieveKpi({
        successConfirmed: true,
        deliverableCount: 0,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: true,
      }),
    ).toBe(false);
  });

  it('kind=ongoing → false', () => {
    expect(
      shouldAutoAchieveKpi({
        successConfirmed: true,
        deliverableCount: 5,
        isAwaiting: false,
        exitedWithError: false,
        isPostComplete: true,
        kind: 'ongoing',
      }),
    ).toBe(false);
  });
});

describe('suggestKpiAction · 终态优先', () => {
  it('status=achieved → action=achieved', () => {
    expect(suggestKpiAction(makeKpi({ status: 'achieved' }), []).action).toBe('achieved');
  });

  it('status=paused → action=continue', () => {
    expect(suggestKpiAction(makeKpi({ status: 'paused' }), []).action).toBe('continue');
  });
});

describe('suggestKpiAction · active 状态', () => {
  it('最近 burst DONE+outcome ok → achieved', () => {
    const link = makeLink({
      registryStatus: 'DONE',
      isPostComplete: true,
      deliverableCount: 2,
      lastOutcomeSuccess: true,
    });
    expect(suggestKpiAction(makeKpi(), [link]).action).toBe('achieved');
  });

  it('outcome 明确失败 → 不 achieved', () => {
    const link = makeLink({
      registryStatus: 'DONE',
      isPostComplete: true,
      deliverableCount: 2,
      lastOutcomeSuccess: false,
    });
    expect(suggestKpiAction(makeKpi(), [link]).action).toBe('continue');
  });

  it('无 outcome 史但 post_complete+有产出 → achieved（兼容）', () => {
    const link = makeLink({
      registryStatus: 'DONE',
      isPostComplete: true,
      deliverableCount: 1,
      lastOutcomeSuccess: null,
    });
    expect(suggestKpiAction(makeKpi(), [link]).action).toBe('achieved');
  });

  it('ongoing KPI：交付完成不结案', () => {
    const link = makeLink({
      registryStatus: 'DONE',
      isPostComplete: true,
      deliverableCount: 2,
      lastOutcomeSuccess: true,
    });
    const r = suggestKpiAction(makeKpi({ kind: 'ongoing' }), [link]);
    expect(r.action).toBe('continue');
  });

  it('ask_user → awaiting_human', () => {
    const link = makeLink({
      isAsyncWaiting: true,
      hasAskUserPending: true,
      registryStatus: 'AWAITING',
    });
    expect(suggestKpiAction(makeKpi(), [link]).action).toBe('awaiting_human');
  });

  it('idle streak 达阈值 → stuck_retry', () => {
    expect(suggestKpiAction(makeKpi({ consecutiveIdleBursts: 3 }), [], 3).action).toBe('stuck_retry');
  });

  it('有 burst RUNNING → continue', () => {
    expect(suggestKpiAction(makeKpi(), [makeLink({ registryStatus: 'RUNNING' })]).action).toBe(
      'continue',
    );
  });
});
