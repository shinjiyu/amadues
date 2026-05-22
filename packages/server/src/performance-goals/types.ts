export type PerformanceGoalType = 'relationship_goal';

export type PerformanceGoalStatus = 'active' | 'paused' | 'completed' | 'archived';

export type GoalTrend = 'up' | 'flat' | 'down';

export type GoalRecommendedActionType = 'none' | 'post_message' | 'set_goal';

export type GoalActionStatus = 'success' | 'failed' | 'skipped';

export interface GoalActionBudget {
  maxProactiveMessagesPerDay?: number;
  maxInnerGoalsPerDay?: number;
}

export interface GoalRubric {
  summary: string;
  positiveSignals: string[];
  negativeSignals: string[];
  allowedActions: GoalRecommendedActionType[];
  constraints: string[];
}

export interface PerformanceGoal {
  id: string;
  title: string;
  goalText: string;
  type: PerformanceGoalType;
  targetSids: string[];
  targetThreadId?: string;
  status: PerformanceGoalStatus;
  priority: number;
  reviewIntervalMs: number;
  minActionCooldownMs: number;
  actionBudget?: GoalActionBudget;
  createdAt: string;
  updatedAt: string;
  rubric?: GoalRubric;
  metadata?: Record<string, unknown>;
}

export interface GoalScorecard {
  goalId: string;
  currentScore: number;
  confidence: number;
  trend: GoalTrend;
  evidenceSummary: string;
  topOpportunity: string;
  topRisk: string;
  suggestedActionType: GoalRecommendedActionType;
  suggestedActionSummary: string;
  suggestedMessage?: string;
  suggestedInnerGoal?: string;
  suggestedThreadId?: string;
  lastActionAt?: string;
  lastActionType?: GoalRecommendedActionType;
  lastActionStatus?: GoalActionStatus;
  lastActionSummary?: string;
  lastReviewedAt: string;
  nextReviewAt: string;
}

export interface GoalJournalEntry {
  goalId: string;
  entryType?: 'review' | 'action';
  reviewedAt: string;
  score: number;
  confidence: number;
  trend: GoalTrend;
  evidenceSummary: string;
  topOpportunity: string;
  topRisk: string;
  suggestedActionType: GoalRecommendedActionType;
  suggestedActionSummary: string;
  actionType?: GoalRecommendedActionType;
  actionStatus?: GoalActionStatus;
  actionSummary?: string;
}

export interface GoalReviewPayload {
  score: number;
  confidence: number;
  trend: GoalTrend;
  evidenceSummary: string;
  topOpportunity: string;
  topRisk: string;
  suggestedActionType: GoalRecommendedActionType;
  suggestedActionSummary: string;
  suggestedMessage?: string;
  suggestedInnerGoal?: string;
  suggestedThreadId?: string;
  nextReviewAfterMs?: number;
}

export interface CompiledPerformanceGoal extends PerformanceGoal {
  rubric: GoalRubric;
}

export interface PerformanceGoalUpsertInput {
  id?: string;
  title?: string;
  goalText: string;
  type?: PerformanceGoalType;
  targetSids?: string[];
  targetThreadId?: string;
  status?: PerformanceGoalStatus;
  priority?: number;
  reviewIntervalMs?: number;
  minActionCooldownMs?: number;
  actionBudget?: GoalActionBudget;
  metadata?: Record<string, unknown>;
}

export interface PerformanceGoalUpdateInput {
  title?: string;
  goalText?: string;
  type?: PerformanceGoalType;
  targetSids?: string[];
  targetThreadId?: string | null;
  status?: PerformanceGoalStatus;
  priority?: number;
  reviewIntervalMs?: number;
  minActionCooldownMs?: number;
  actionBudget?: GoalActionBudget;
  metadata?: Record<string, unknown>;
}
