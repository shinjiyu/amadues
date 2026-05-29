import { parseJsonObjectFromLlmText } from '@utlra/chat-ir';
import { randomUUID } from 'node:crypto';
import { formatAgentIsoLocal } from '../agent-time.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { llmRawChatCompletion } from '../llm/raw.js';
import type { OuterMemoryStore } from '../outer/outer-memory.js';
import { compilePerformanceGoal, compilePerformanceGoals } from './compiler.js';
import { PerformanceGoalStore } from './store.js';
import type {
  CompiledPerformanceGoal,
  GoalActionStatus,
  GoalJournalEntry,
  GoalRecommendedActionType,
  GoalReviewPayload,
  GoalScorecard,
  GoalTrend,
  PerformanceGoal,
  PerformanceGoalStatus,
  PerformanceGoalUpdateInput,
  PerformanceGoalUpsertInput,
} from './types.js';

const MAX_REVIEWS_PER_TICK = 2;
const MIN_NEXT_REVIEW_MS = 10 * 60 * 1000;
const MAX_NEXT_REVIEW_MS = 7 * 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTrend(value: unknown): GoalTrend {
  return value === 'up' || value === 'down' ? value : 'flat';
}

function normalizeActionType(value: unknown): GoalRecommendedActionType {
  return value === 'post_message' || value === 'set_goal' ? value : 'none';
}

function normalizeGoalStatus(value: unknown): PerformanceGoalStatus {
  return value === 'paused' || value === 'completed' || value === 'archived' ? value : 'active';
}

function defaultReview(goal: CompiledPerformanceGoal, previous: GoalScorecard | null, nowIso: string): GoalReviewPayload {
  return {
    score: previous?.currentScore ?? 50,
    confidence: previous?.confidence ?? 0.2,
    trend: previous?.trend ?? 'flat',
    evidenceSummary: '当前可用证据不足，先维持已有判断，等待更多互动信号。',
    topOpportunity: goal.rubric.positiveSignals[0] ?? '继续观察高价值互动机会',
    topRisk: goal.rubric.negativeSignals[0] ?? '避免无价值的主动打扰',
    suggestedActionType: 'none',
    suggestedActionSummary: `本轮不主动行动，等待到 ${nowIso} 之后积累更多证据。`,
    nextReviewAfterMs: goal.reviewIntervalMs,
  };
}

function buildReviewSystemPrompt(): string {
  return `你是一个谨慎的“长期绩效目标审阅器”。

你的任务不是直接行动，而是为 agent 的长期自驱动目标做一次结构化评估。

硬约束：
1. 不要为了提高分数而鼓励骚扰、刷存在感或情感操控
2. 不要建议撒谎、PUA、制造依赖、越界承诺
3. 若证据不足，应保守，优先返回 suggestedActionType="none"
4. 分数是 0-100，表示目标接近程度，不是“热情程度”
5. 只允许三种建议动作：none / post_message / set_goal
6. post_message 必须强调“有明确价值且克制”；set_goal 应是准备型工作，不是空转

返回 JSON：
{
  "score": 0-100 number,
  "confidence": 0-1 number,
  "trend": "up" | "flat" | "down",
  "evidenceSummary": "string",
  "topOpportunity": "string",
  "topRisk": "string",
  "suggestedActionType": "none" | "post_message" | "set_goal",
  "suggestedActionSummary": "string",
  "suggestedMessage": "string optional",
  "suggestedInnerGoal": "string optional",
  "suggestedThreadId": "string optional",
  "nextReviewAfterMs": number
}`;
}

function buildReviewUserPrompt(
  goal: CompiledPerformanceGoal,
  previous: GoalScorecard | null,
  evidenceBlock: string,
  journalBlock: string,
): string {
  const previousBlock = previous
    ? [
        `goal_id: ${goal.id}`,
        `上次评分：${previous.currentScore}`,
        `上次置信度：${previous.confidence}`,
        `上次趋势：${previous.trend}`,
        `上次证据总结：${previous.evidenceSummary}`,
        `上次建议动作：${previous.suggestedActionType} - ${previous.suggestedActionSummary}`,
        `最近执行动作：${previous.lastActionType ?? '无'} / ${previous.lastActionStatus ?? '无'} / ${previous.lastActionSummary ?? '无'}`,
      ].join('\n')
    : '无';

  return [
    `# 绩效目标`,
    `ID: ${goal.id}`,
    `标题: ${goal.title}`,
    `类型: ${goal.type}`,
    `目标描述: ${goal.goalText}`,
    `目标用户: ${goal.targetSids.join(', ') || '无'}`,
    `目标线程: ${goal.targetThreadId ?? '未指定'}`,
    '',
    `# 评分 Rubric`,
    `概述: ${goal.rubric.summary}`,
    `正向信号:`,
    ...goal.rubric.positiveSignals.map((item) => `- ${item}`),
    `负向信号:`,
    ...goal.rubric.negativeSignals.map((item) => `- ${item}`),
    `约束:`,
    ...goal.rubric.constraints.map((item) => `- ${item}`),
    '',
    `# 上次评分卡`,
    previousBlock,
    '',
    `# 最近审阅日志`,
    journalBlock || '无',
    '',
    `# 当前证据`,
    evidenceBlock || '无',
  ].join('\n');
}

function parseReviewPayload(
  rawContent: string,
  goal: CompiledPerformanceGoal,
  previous: GoalScorecard | null,
  nowIso: string,
): GoalReviewPayload {
  const parsed = parseJsonObjectFromLlmText(rawContent) as Record<string, unknown>;
  const actionType = normalizeActionType(parsed['suggestedActionType']);
  const suggestedThreadId = typeof parsed['suggestedThreadId'] === 'string'
    ? parsed['suggestedThreadId'].trim()
    : goal.targetThreadId;
  return {
    score: clamp(Number(parsed['score'] ?? previous?.currentScore ?? 50), 0, 100),
    confidence: clamp(Number(parsed['confidence'] ?? previous?.confidence ?? 0.2), 0, 1),
    trend: normalizeTrend(parsed['trend']),
    evidenceSummary: String(parsed['evidenceSummary'] ?? '').trim() || '本轮没有产出明确证据总结。',
    topOpportunity: String(parsed['topOpportunity'] ?? '').trim() || goal.rubric.positiveSignals[0] || '继续寻找正向信号',
    topRisk: String(parsed['topRisk'] ?? '').trim() || goal.rubric.negativeSignals[0] || '避免无意义打扰',
    suggestedActionType: actionType,
    suggestedActionSummary: String(parsed['suggestedActionSummary'] ?? '').trim() || '无动作建议',
    ...(typeof parsed['suggestedMessage'] === 'string' && parsed['suggestedMessage'].trim()
      ? { suggestedMessage: parsed['suggestedMessage'].trim().slice(0, 500) }
      : {}),
    ...(typeof parsed['suggestedInnerGoal'] === 'string' && parsed['suggestedInnerGoal'].trim()
      ? { suggestedInnerGoal: parsed['suggestedInnerGoal'].trim().slice(0, 800) }
      : {}),
    ...(suggestedThreadId ? { suggestedThreadId } : {}),
    nextReviewAfterMs: clamp(
      Number(parsed['nextReviewAfterMs'] ?? goal.reviewIntervalMs),
      MIN_NEXT_REVIEW_MS,
      MAX_NEXT_REVIEW_MS,
    ),
  };
}

export class PerformanceGoalEngine {
  private readonly store: PerformanceGoalStore;

  constructor(dataRoot: string) {
    this.store = new PerformanceGoalStore(dataRoot);
    this.store.ensureFiles();
  }

  listGoalStates(options?: { includeArchived?: boolean }): Array<{
    goal: CompiledPerformanceGoal;
    scorecard: GoalScorecard | null;
    recentJournal: GoalJournalEntry[];
  }> {
    const includeArchived = options?.includeArchived ?? false;
    return compilePerformanceGoals(this.store.listGoals())
      .filter((goal) => includeArchived || goal.status !== 'archived')
      .sort((a, b) => b.priority - a.priority)
      .map((goal) => ({
        goal,
        scorecard: this.store.getScorecard(goal.id),
        recentJournal: this.store.listRecentJournal(goal.id, 10),
      }));
  }

  getDashboardSnapshot(options?: { includeArchived?: boolean }): {
    generatedAt: string;
    totalGoals: number;
    activeGoals: number;
    actionableGoals: number;
    averageScore: number | null;
    statusCounts: Record<string, number>;
    goals: Array<{
      goal: CompiledPerformanceGoal;
      scorecard: GoalScorecard | null;
      recentJournal: GoalJournalEntry[];
    }>;
  } {
    const goals = this.listGoalStates(options);
    const scored = goals.map((entry) => entry.scorecard).filter((entry): entry is GoalScorecard => entry !== null);
    const averageScore = scored.length > 0
      ? Math.round((scored.reduce((sum, entry) => sum + entry.currentScore, 0) / scored.length) * 10) / 10
      : null;
    const statusCounts = goals.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.goal.status] = (acc[entry.goal.status] ?? 0) + 1;
      return acc;
    }, {});

    return {
      generatedAt: new Date().toISOString(),
      totalGoals: goals.length,
      activeGoals: goals.filter((entry) => entry.goal.status === 'active').length,
      actionableGoals: goals.filter((entry) => {
        const actionType = entry.scorecard?.suggestedActionType ?? 'none';
        return entry.goal.status === 'active' && actionType !== 'none';
      }).length,
      averageScore,
      statusCounts,
      goals,
    };
  }

  createGoal(input: PerformanceGoalUpsertInput): CompiledPerformanceGoal {
    const nowIso = new Date().toISOString();
    const compiled = compilePerformanceGoal({
      id: input.id?.trim() || `pg:${randomUUID()}`,
      title: input.title?.trim() ?? '',
      goalText: input.goalText,
      type: input.type ?? 'relationship_goal',
      targetSids: input.targetSids ?? [],
      ...(input.targetThreadId?.trim() ? { targetThreadId: input.targetThreadId.trim() } : {}),
      status: normalizeGoalStatus(input.status),
      priority: input.priority ?? 50,
      reviewIntervalMs: input.reviewIntervalMs ?? 0,
      minActionCooldownMs: input.minActionCooldownMs ?? 0,
      actionBudget: input.actionBudget,
      createdAt: nowIso,
      updatedAt: nowIso,
      metadata: input.metadata,
    });
    this.store.upsertGoal(compiled);
    return compiled;
  }

  updateGoal(goalId: string, patch: PerformanceGoalUpdateInput): CompiledPerformanceGoal | null {
    const current = this.store.getGoal(goalId);
    if (!current) return null;
    const merged: PerformanceGoal = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.goalText !== undefined ? { goalText: patch.goalText } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.targetSids !== undefined ? { targetSids: patch.targetSids } : {}),
      ...(patch.targetThreadId !== undefined
        ? (patch.targetThreadId?.trim()
            ? { targetThreadId: patch.targetThreadId.trim() }
            : {})
        : ('targetThreadId' in current ? { targetThreadId: current.targetThreadId } : {})),
      ...(patch.status !== undefined ? { status: normalizeGoalStatus(patch.status) } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.reviewIntervalMs !== undefined ? { reviewIntervalMs: patch.reviewIntervalMs } : {}),
      ...(patch.minActionCooldownMs !== undefined
        ? { minActionCooldownMs: patch.minActionCooldownMs }
        : {}),
      ...(patch.actionBudget !== undefined ? { actionBudget: patch.actionBudget } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      updatedAt: new Date().toISOString(),
    };

    if (patch.targetThreadId === null || patch.targetThreadId === '') {
      delete merged.targetThreadId;
    }

    const compiled = compilePerformanceGoal(merged);
    this.store.upsertGoal(compiled);
    return compiled;
  }

  deleteGoal(goalId: string): boolean {
    return this.store.deleteGoal(goalId);
  }

  recordActionOutcome(
    goalId: string,
    actionType: GoalRecommendedActionType,
    status: GoalActionStatus,
    summary: string,
  ): GoalScorecard | null {
    const goal = compilePerformanceGoals(this.store.listGoals()).find((entry) => entry.id === goalId);
    if (!goal) return null;

    const nowIso = new Date().toISOString();
    const previous = this.store.getScorecard(goalId);
    const nextReviewMs =
      status === 'success'
        ? goal.minActionCooldownMs
        : Math.min(goal.reviewIntervalMs, 60 * 60 * 1000);
    const scorecard: GoalScorecard = {
      goalId,
      currentScore: previous?.currentScore ?? 50,
      confidence: previous?.confidence ?? 0.2,
      trend: previous?.trend ?? 'flat',
      evidenceSummary: previous?.evidenceSummary ?? '等待更多证据更新。',
      topOpportunity: previous?.topOpportunity ?? goal.rubric.positiveSignals[0] ?? '继续观察',
      topRisk: previous?.topRisk ?? goal.rubric.negativeSignals[0] ?? '避免无意义打扰',
      suggestedActionType: status === 'success' ? 'none' : (previous?.suggestedActionType ?? actionType),
      suggestedActionSummary:
        status === 'success'
          ? `最近已执行 ${actionType}，先等待反馈再决定下一步。`
          : previous?.suggestedActionSummary ?? summary,
      ...(previous?.suggestedMessage ? { suggestedMessage: previous.suggestedMessage } : {}),
      ...(previous?.suggestedInnerGoal ? { suggestedInnerGoal: previous.suggestedInnerGoal } : {}),
      ...(previous?.suggestedThreadId ? { suggestedThreadId: previous.suggestedThreadId } : {}),
      lastActionAt: nowIso,
      lastActionType: actionType,
      lastActionStatus: status,
      lastActionSummary: summary,
      lastReviewedAt: previous?.lastReviewedAt ?? nowIso,
      nextReviewAt: new Date(Date.now() + nextReviewMs).toISOString(),
    };
    this.store.upsertScorecard(scorecard);
    this.store.appendJournal({
      goalId,
      entryType: 'action',
      reviewedAt: nowIso,
      score: scorecard.currentScore,
      confidence: scorecard.confidence,
      trend: scorecard.trend,
      evidenceSummary: scorecard.evidenceSummary,
      topOpportunity: scorecard.topOpportunity,
      topRisk: scorecard.topRisk,
      suggestedActionType: scorecard.suggestedActionType,
      suggestedActionSummary: scorecard.suggestedActionSummary,
      actionType,
      actionStatus: status,
      actionSummary: summary,
    });
    return scorecard;
  }

  async reviewGoalsForHeartbeat(
    env: InnerLlmEnv,
    memoryStore?: OuterMemoryStore,
  ): Promise<string> {
    const compiledGoals = compilePerformanceGoals(
      this.store.listGoals(),
    )
      .filter((goal) => goal.status === 'active')
      .sort((a, b) => b.priority - a.priority);
    if (compiledGoals.length === 0) return '';

    const scorecards = new Map(
      this.store.listScorecards().map((entry) => [entry.goalId, entry]),
    );
    const now = Date.now();
    const dueGoals = compiledGoals
      .filter((goal) => {
        const scorecard = scorecards.get(goal.id);
        if (!scorecard) return true;
        return new Date(scorecard.nextReviewAt).getTime() <= now;
      })
      .slice(0, MAX_REVIEWS_PER_TICK);

    for (const goal of dueGoals) {
      const previous = scorecards.get(goal.id) ?? null;
      const reviewed = await this.reviewSingleGoal(env, goal, previous, memoryStore);
      scorecards.set(goal.id, reviewed);
      this.store.upsertScorecard(reviewed);
      this.store.appendJournal(this.toJournalEntry(reviewed));
    }

    return this.renderHeartbeatBlock(compiledGoals, scorecards);
  }

  private async reviewSingleGoal(
    env: InnerLlmEnv,
    goal: CompiledPerformanceGoal,
    previous: GoalScorecard | null,
    memoryStore?: OuterMemoryStore,
  ): Promise<GoalScorecard> {
    const nowIso = new Date().toISOString();
    const query = [goal.title, goal.goalText, ...goal.targetSids].filter(Boolean).join(' ').slice(0, 200);
    const memory = memoryStore
      ? await memoryStore.readMemoryContext(query)
      : { dailyLog: '', tasks: '', hasAny: false };
    const evidenceBlock = [
      '## 当前任务状态',
      memory.tasks,
      '',
      '## 近期相关对话 / 记忆',
      memory.dailyLog,
    ].join('\n');
    const recentJournal = this.store.listRecentJournal(goal.id, 3)
      .map((entry) => entry.entryType === 'action'
        ? `- ${entry.reviewedAt} action=${entry.actionType} status=${entry.actionStatus}: ${entry.actionSummary}`
        : `- ${entry.reviewedAt} score=${entry.score} trend=${entry.trend} action=${entry.suggestedActionType}: ${entry.suggestedActionSummary}`)
      .join('\n');

    let payload = defaultReview(goal, previous, nowIso);
    try {
      const { raw } = await llmRawChatCompletion<{
        error?: { message?: string; code?: string };
        choices?: Array<{ message?: { content?: string | null } }>;
      }>({
        provider: env.provider,
        apiKey: env.apiKey,
        baseUrl: env.baseUrl,
        body: {
          model: env.textModel,
          messages: [
            { role: 'system', content: buildReviewSystemPrompt() },
            { role: 'user', content: buildReviewUserPrompt(goal, previous, evidenceBlock, recentJournal) },
          ],
          max_tokens: 1200,
          temperature: 0.2,
          thinking: { type: 'disabled' },
        },
      });
      const content = raw.choices?.[0]?.message?.content?.trim() ?? '';
      if (content) {
        payload = parseReviewPayload(content, goal, previous, nowIso);
      }
    } catch (e) {
      console.warn(`[performance-goals] review failed for ${goal.id}:`, e);
    }

    return {
      goalId: goal.id,
      currentScore: payload.score,
      confidence: payload.confidence,
      trend: payload.trend,
      evidenceSummary: payload.evidenceSummary,
      topOpportunity: payload.topOpportunity,
      topRisk: payload.topRisk,
      suggestedActionType: payload.suggestedActionType,
      suggestedActionSummary: payload.suggestedActionSummary,
      ...(payload.suggestedMessage ? { suggestedMessage: payload.suggestedMessage } : {}),
      ...(payload.suggestedInnerGoal ? { suggestedInnerGoal: payload.suggestedInnerGoal } : {}),
      ...(payload.suggestedThreadId ? { suggestedThreadId: payload.suggestedThreadId } : {}),
      lastReviewedAt: nowIso,
      nextReviewAt: new Date(Date.now() + (payload.nextReviewAfterMs ?? goal.reviewIntervalMs)).toISOString(),
    };
  }

  private toJournalEntry(scorecard: GoalScorecard): GoalJournalEntry {
    return {
      goalId: scorecard.goalId,
      entryType: 'review',
      reviewedAt: scorecard.lastReviewedAt,
      score: scorecard.currentScore,
      confidence: scorecard.confidence,
      trend: scorecard.trend,
      evidenceSummary: scorecard.evidenceSummary,
      topOpportunity: scorecard.topOpportunity,
      topRisk: scorecard.topRisk,
      suggestedActionType: scorecard.suggestedActionType,
      suggestedActionSummary: scorecard.suggestedActionSummary,
    };
  }

  private renderHeartbeatBlock(
    goals: CompiledPerformanceGoal[],
    scorecards: Map<string, GoalScorecard>,
  ): string {
    const lines: string[] = ['## 绩效目标状态'];
    for (const goal of goals.slice(0, 5)) {
      const scorecard = scorecards.get(goal.id);
      lines.push('');
      lines.push(`### ${goal.title}`);
      lines.push(`- goal_id: ${goal.id}`);
      lines.push(`- 类型: ${goal.type}`);
      lines.push(`- 描述: ${goal.goalText}`);
      lines.push(`- 对象: ${goal.targetSids.join(', ') || '无'}`);
      if (goal.targetThreadId) lines.push(`- 目标线程: ${goal.targetThreadId}`);
      if (scorecard) {
        lines.push(`- 当前分数: ${scorecard.currentScore}/100`);
        lines.push(`- 趋势: ${scorecard.trend} (confidence=${scorecard.confidence.toFixed(2)})`);
        lines.push(`- 最近证据: ${scorecard.evidenceSummary}`);
        lines.push(`- 当前机会: ${scorecard.topOpportunity}`);
        lines.push(`- 当前风险: ${scorecard.topRisk}`);
        lines.push(`- 建议动作: ${scorecard.suggestedActionType} - ${scorecard.suggestedActionSummary}`);
        if (scorecard.suggestedThreadId) lines.push(`- 建议 thread_id: ${scorecard.suggestedThreadId}`);
        if (scorecard.suggestedMessage) lines.push(`- 建议消息: ${scorecard.suggestedMessage}`);
        if (scorecard.suggestedInnerGoal) lines.push(`- 建议内脑任务: ${scorecard.suggestedInnerGoal}`);
        if (scorecard.lastActionAt) {
          lines.push(
            `- 最近动作: ${scorecard.lastActionType ?? 'unknown'} / ${scorecard.lastActionStatus ?? 'unknown'} / ${scorecard.lastActionSummary ?? '无'} @ ${formatAgentIsoLocal(scorecard.lastActionAt)}`,
          );
        }
        lines.push(`- 下次审阅: ${formatAgentIsoLocal(scorecard.nextReviewAt)}`);
      } else {
        lines.push('- 当前分数: 尚未审阅');
        lines.push(`- Rubric: ${goal.rubric.summary}`);
      }
    }
    lines.push('');
    lines.push('请优先考虑这些绩效目标，但仍必须遵守“有价值、克制、不骚扰”的原则。若建议动作是 none，则优先选择不行动。');
    return lines.join('\n');
  }
}
