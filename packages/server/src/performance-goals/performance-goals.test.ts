import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderPerformanceDashboard } from './dashboard.js';
import { compilePerformanceGoal } from './compiler.js';
import { PerformanceGoalEngine } from './engine.js';
import { PerformanceGoalStore } from './store.js';
import type { PerformanceGoal } from './types.js';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'performance-goals-'));
}

const cleanupRoots: string[] = [];

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const dir = cleanupRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('performance goals compiler', () => {
  it('fills relationship goal defaults', () => {
    const compiled = compilePerformanceGoal({
      id: 'goal-1',
      title: '',
      goalText: '讨好 shinjiyu，但必须靠有价值的帮助',
      type: 'relationship_goal',
      targetSids: ['discord:user:1'],
      status: 'active',
      priority: 0,
      reviewIntervalMs: 0,
      minActionCooldownMs: 0,
      createdAt: '',
      updatedAt: '',
    });

    expect(compiled.title).toContain('讨好');
    expect(compiled.reviewIntervalMs).toBeGreaterThan(0);
    expect(compiled.minActionCooldownMs).toBeGreaterThan(0);
    expect(compiled.rubric.allowedActions).toContain('post_message');
  });
});

describe('performance goal store', () => {
  it('creates backing files and can upsert scorecards', () => {
    const root = makeTempRoot();
    cleanupRoots.push(root);
    const store = new PerformanceGoalStore(root);
    store.ensureFiles();

    expect(fs.existsSync(store.goalsPath)).toBe(true);
    expect(fs.existsSync(store.scorecardsPath)).toBe(true);
    expect(fs.existsSync(store.journalPath)).toBe(true);

    store.upsertScorecard({
      goalId: 'goal-1',
      currentScore: 55,
      confidence: 0.7,
      trend: 'up',
      evidenceSummary: '用户最近多次主动互动',
      topOpportunity: '继续提供有效帮助',
      topRisk: '不要刷存在感',
      suggestedActionType: 'none',
      suggestedActionSummary: '先观察',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
      nextReviewAt: '2026-01-02T00:00:00.000Z',
    });

    expect(store.getScorecard('goal-1')?.currentScore).toBe(55);
  });
});

describe('performance goal engine', () => {
  it('supports create update and delete flows', () => {
    const root = makeTempRoot();
    cleanupRoots.push(root);
    const engine = new PerformanceGoalEngine(root);

    const created = engine.createGoal({
      title: '提升关系质量',
      goalText: '通过持续提供有效帮助，让对方更愿意主动找 agent',
      targetSids: ['discord:user:1'],
      targetThreadId: 'thread:discord:abc',
      priority: 90,
    });

    expect(created.id).toContain('pg:');
    expect(engine.listGoalStates().length).toBe(1);

    const updated = engine.updateGoal(created.id, {
      status: 'paused',
      title: '暂停中的关系目标',
      targetThreadId: '',
    });

    expect(updated?.status).toBe('paused');
    expect(updated?.title).toBe('暂停中的关系目标');
    expect(updated?.targetThreadId).toBeUndefined();

    expect(engine.deleteGoal(created.id)).toBe(true);
    expect(engine.listGoalStates().length).toBe(0);
  });

  it('records action outcomes back to scorecard and journal', () => {
    const root = makeTempRoot();
    cleanupRoots.push(root);
    const engine = new PerformanceGoalEngine(root);
    const created = engine.createGoal({
      title: '提升 shinjiyu 关系质量',
      goalText: '通过关键时刻提供帮助提升信任度',
      targetSids: ['discord:user:1'],
      targetThreadId: 'thread:discord:abc',
      minActionCooldownMs: 30 * 60 * 1000,
    });

    const scorecard = engine.recordActionOutcome(
      created.id,
      'post_message',
      'success',
      '已发送 IM 消息至 thread:discord:abc（24 字符）',
    );

    expect(scorecard?.lastActionType).toBe('post_message');
    expect(scorecard?.lastActionStatus).toBe('success');
    expect(scorecard?.suggestedActionType).toBe('none');

    const states = engine.listGoalStates();
    expect(states[0]?.recentJournal.some((entry) => entry.entryType === 'action')).toBe(true);
  });

  it('builds dashboard snapshot and renders html view', () => {
    const root = makeTempRoot();
    cleanupRoots.push(root);
    const engine = new PerformanceGoalEngine(root);
    const created = engine.createGoal({
      title: '提升 shinjiyu 关系质量',
      goalText: '通过持续帮助提升互动质量',
      targetSids: ['discord:user:1'],
      priority: 75,
    });
    engine.recordActionOutcome(created.id, 'post_message', 'success', '已发送 IM 消息');

    const snapshot = engine.getDashboardSnapshot({ includeArchived: true });
    expect(snapshot.totalGoals).toBe(1);
    expect(snapshot.activeGoals).toBe(1);
    expect(snapshot.averageScore).not.toBeNull();

    const html = renderPerformanceDashboard(engine);
    expect(html).toContain('Performance Goals Dashboard');
    expect(html).toContain(created.id);
    expect(html).toContain('平均分');
  });

  it('renders existing scorecards into heartbeat context without forcing review', async () => {
    const root = makeTempRoot();
    cleanupRoots.push(root);
    const store = new PerformanceGoalStore(root);
    store.ensureFiles();

    const goal: PerformanceGoal = {
      id: 'goal-1',
      title: '提升 shinjiyu 关系质量',
      goalText: '通过持续提供有价值帮助，让 shinjiyu 更愿意主动找 agent',
      type: 'relationship_goal',
      targetSids: ['discord:user:1'],
      targetThreadId: 'thread:discord:abc',
      status: 'active',
      priority: 80,
      reviewIntervalMs: 6 * 60 * 60 * 1000,
      minActionCooldownMs: 6 * 60 * 60 * 1000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(store.goalsPath, JSON.stringify([goal], null, 2) + '\n', 'utf8');
    store.upsertScorecard({
      goalId: 'goal-1',
      currentScore: 61,
      confidence: 0.82,
      trend: 'up',
      evidenceSummary: '最近互动质量较好',
      topOpportunity: '继续在关键时刻提供帮助',
      topRisk: '不要无意义主动打扰',
      suggestedActionType: 'post_message',
      suggestedActionSummary: '可在目标线程发一条有价值的提醒',
      suggestedThreadId: 'thread:discord:abc',
      suggestedMessage: '如果你今晚还要处理发布，我可以先帮你整理检查项。',
      lastReviewedAt: '2026-01-01T00:00:00.000Z',
      nextReviewAt: '2099-01-01T00:00:00.000Z',
    });

    const engine = new PerformanceGoalEngine(root);
    const block = await engine.reviewGoalsForHeartbeat({
      provider: 'kimi',
      apiKey: 'test',
      baseUrl: 'https://example.invalid/v1',
      textModel: 'kimi-k2.6',
      visionModel: 'kimi-k2.6',
      maxTokensText: 1000,
      maxTokensMultimodal: 1000,
      thinking: 'disabled',
    });

    expect(block).toContain('绩效目标状态');
    expect(block).toContain('提升 shinjiyu 关系质量');
    expect(block).toContain('当前分数: 61/100');
    expect(block).toContain('goal_id: goal-1');
    expect(block).toContain('建议 thread_id: thread:discord:abc');
  });
});
