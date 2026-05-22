import type {
  CompiledPerformanceGoal,
  GoalRubric,
  PerformanceGoal,
} from './types.js';

const DEFAULT_REVIEW_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ACTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function buildRelationshipRubric(goal: PerformanceGoal): GoalRubric {
  const targetLabel = goal.targetSids.length > 0 ? goal.targetSids.join(', ') : '目标用户';
  return {
    summary:
      `持续提升 ${targetLabel} 对 agent 的主观价值感、信任度与互动质量。` +
      '优先追求“有用、稳定、被愿意主动找”的关系，而不是频繁刷存在感。',
    positiveSignals: [
      '目标用户主动 @ agent 或直接发起对话',
      '目标用户采纳 agent 的建议或交付更多任务',
      '目标用户的回复更积极、更具体，或明确表达认可/感谢',
      'agent 在关键时刻提供了实质帮助、提醒或准备工作',
    ],
    negativeSignals: [
      '目标用户对 agent 的主动消息无回应，或连续多次低响应',
      'agent 的输出被视为打扰、无意义或时机不当',
      '为了追求目标而编造事实、过度承诺、情感操控或施压',
      '同类主动触达过密，造成骚扰感',
    ],
    allowedActions: ['none', 'post_message', 'set_goal'],
    constraints: [
      '主动消息必须有明确价值，不得为了刷存在感而输出填充内容',
      '不得撒谎、PUA、情感操控、诱导依赖或越过用户边界',
      '遇到负反馈时应降频、暂停或改用准备型任务，而不是继续贴脸输出',
    ],
  };
}

export function compilePerformanceGoal(raw: PerformanceGoal): CompiledPerformanceGoal {
  const type = raw.type ?? 'relationship_goal';
  const now = new Date().toISOString();
  const compiledBase: PerformanceGoal = {
    id: raw.id,
    title: raw.title?.trim() || raw.goalText.trim().slice(0, 80) || raw.id,
    goalText: raw.goalText?.trim() || '',
    type,
    targetSids: raw.targetSids ?? [],
    ...(raw.targetThreadId?.trim() ? { targetThreadId: raw.targetThreadId.trim() } : {}),
    status: raw.status ?? 'active',
    priority: Number.isFinite(raw.priority) ? raw.priority : 50,
    reviewIntervalMs: Number.isFinite(raw.reviewIntervalMs) && (raw.reviewIntervalMs ?? 0) > 0
      ? raw.reviewIntervalMs
      : DEFAULT_REVIEW_INTERVAL_MS,
    minActionCooldownMs: Number.isFinite(raw.minActionCooldownMs) && (raw.minActionCooldownMs ?? 0) > 0
      ? raw.minActionCooldownMs
      : DEFAULT_ACTION_COOLDOWN_MS,
    actionBudget: raw.actionBudget,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    metadata: raw.metadata,
  };

  const rubric = raw.rubric ?? buildRelationshipRubric(compiledBase);
  return {
    ...compiledBase,
    rubric,
  };
}

export function compilePerformanceGoals(goals: PerformanceGoal[]): CompiledPerformanceGoal[] {
  return goals.map(compilePerformanceGoal);
}
