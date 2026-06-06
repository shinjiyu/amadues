import { afterEach, describe, expect, it } from 'vitest';

import {
  LIVE_BUDGET_MARKER,
  buildLiveResourceBudgetSection,
  buildStaticResourceBudgetSection,
  resolveBaseNodeBudget,
  upsertLiveBudgetMessage,
} from './resource-budget.js';

describe('resource-budget', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('resolveBaseNodeBudget reads env', () => {
    process.env['INNER_BASE_NODE_MAX_ROUNDS'] = '12';
    process.env['INNER_BASE_NODE_FAIL_FAST_STREAK'] = '3';
    expect(resolveBaseNodeBudget()).toEqual({ maxRounds: 12, failFastStreak: 3 });
  });

  it('buildStaticResourceBudgetSection includes baseNode limits', () => {
    const s = buildStaticResourceBudgetSection('baseNode');
    expect(s).toContain('INNER_BASE_NODE_MAX_ROUNDS');
    expect(s).toContain('50');
  });

  it('buildLiveResourceBudgetSection shows round and tool counts', () => {
    const s = buildLiveResourceBudgetSection({
      round: 39,
      maxRounds: 50,
      toolCalls: 87,
      noProgressStreak: 0,
      failFastStreak: 5,
    });
    expect(s).toContain(LIVE_BUDGET_MARKER);
    expect(s).toContain('40 / 50');
    expect(s).toContain('87');
    expect(s).toContain('0 / 5');
  });

  it('emits soft threshold at 80%', () => {
    const s = buildLiveResourceBudgetSection({ round: 39, maxRounds: 50, toolCalls: 1 });
    expect(s).toContain('八成');
  });

  it('emits urgent threshold at 90%', () => {
    const s = buildLiveResourceBudgetSection({ round: 44, maxRounds: 50, toolCalls: 1 });
    expect(s).toContain('紧急');
  });

  it('upsertLiveBudgetMessage prepends to first user and replaces prior block', () => {
    const first = upsertLiveBudgetMessage(
      [{ role: 'user', content: 'task' }],
      buildLiveResourceBudgetSection({ round: 0, maxRounds: 10, toolCalls: 0 }),
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.content).toContain('1 / 10');
    expect(first[0]?.content).toContain('task');
    const second = upsertLiveBudgetMessage(
      first,
      buildLiveResourceBudgetSection({ round: 1, maxRounds: 10, toolCalls: 2 }),
    );
    expect(second).toHaveLength(1);
    expect(second[0]?.content).toContain('2 / 10');
    expect(second[0]?.content).toContain('**2** 次');
    expect(second[0]?.content).toContain('task');
    expect(second[0]?.content?.match(/1 \/ 10/g)?.length ?? 0).toBe(0);
  });
});
