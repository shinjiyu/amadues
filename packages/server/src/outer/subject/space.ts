import { ALLOWED_ACTIONS, DEFAULT_GOAL_TEXT, DEFAULT_IDENTITY, type SubjectAction } from './constants.js';
import { clamp01 } from './text.js';
import type { Candidate, ScoreDims, SubjectGoal } from './types.js';

/** Abstract kinds. Tool names are not members of this set. */
export const ABSTRACT_TYPES = [
  'observe',
  'think',
  'act',
  'defer',
  'silence',
  'express',
  'self_work',
  'decline',
  'revisit',
  'wait',
] as const;

export type AbstractType = (typeof ABSTRACT_TYPES)[number];

/**
 * Closed projection. `act` and `observe` both land on `do_nothing`:
 * an abstract step is not a tool call. World-facing work is only `self_work`.
 */
export const PROJECTION: Record<AbstractType, SubjectAction> = {
  observe: 'do_nothing',
  think: 'wait',
  act: 'do_nothing',
  defer: 'defer',
  silence: 'no_reply',
  express: 'reply_to_thread',
  self_work: 'propose_self_work',
  decline: 'decline',
  revisit: 'schedule_revisit',
  wait: 'wait',
};

/** Concrete whitelist name → the abstract type used when the model already named the projection. */
const INVERSE: Record<SubjectAction, AbstractType> = {
  do_nothing: 'observe',
  wait: 'wait',
  no_reply: 'silence',
  reply_to_thread: 'express',
  propose_self_work: 'self_work',
  schedule_revisit: 'revisit',
  decline: 'decline',
  defer: 'defer',
};

const ABSTRACT = new Set<string>(ABSTRACT_TYPES);
const ALLOWED = new Set<string>(ALLOWED_ACTIONS);

export function projectDecision(name: string): { type: AbstractType; action: SubjectAction } | null {
  const trimmed = name.trim();
  if (ABSTRACT.has(trimmed)) {
    const type = trimmed as AbstractType;
    return { type, action: PROJECTION[type] };
  }
  if (ALLOWED.has(trimmed)) {
    const action = trimmed as SubjectAction;
    return { type: INVERSE[action], action };
  }
  return null;
}

/** Set `type` to the abstract kind and `action` to its concrete projection. Unknown names stay unprojected. */
export function materializeCandidate(candidate: Candidate): Candidate {
  const hinted = (candidate.type ?? candidate.action).trim();
  const projected = projectDecision(hinted);
  if (!projected) {
    candidate.type = hinted;
    candidate.action = hinted;
    return candidate;
  }
  candidate.type = projected.type;
  candidate.action = projected.action;
  return candidate;
}

export const SCORE_DIMS = [
  'alignment',
  'novelty',
  'cost',
  'risk',
  'socialPressure',
  'completionPressure',
] as const;

export type ScoreDim = (typeof SCORE_DIMS)[number];

/** Higher cost and risk reduce the point. The other dims increase it. */
export const SCORE_WEIGHTS: Record<ScoreDim, number> = {
  alignment: 1,
  novelty: 0.6,
  cost: 0.8,
  risk: 1,
  socialPressure: 0.7,
  completionPressure: 0.9,
};

export function hasExplicitDims(dims: ScoreDims | undefined): boolean {
  if (!dims) return false;
  return SCORE_DIMS.some((dim) => typeof dims[dim] === 'number' && Number.isFinite(dims[dim]));
}

/** Oriented mean of the six dims. Missing dims use `fallback`. Cost and risk are inverted. */
export function orientDims(dims: ScoreDims | undefined, fallback: number): number {
  const base = clamp01(fallback);
  let weighted = 0;
  let weightSum = 0;
  for (const dim of SCORE_DIMS) {
    const raw = dims?.[dim];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? clamp01(raw) : base;
    const oriented = dim === 'cost' || dim === 'risk' ? 1 - value : value;
    const weight = SCORE_WEIGHTS[dim];
    weighted += weight * oriented;
    weightSum += weight;
  }
  return weightSum === 0 ? 0 : weighted / weightSum;
}

export const GOAL_LAYERS = [
  'identity',
  'north_star',
  'mission',
  'commitment',
  'constraint',
  'success_signal',
] as const;

export type GoalLayer = (typeof GOAL_LAYERS)[number];
export type GoalRelation = 'serves' | 'constrains' | 'evidences' | 'commits';

function node(
  id: string,
  layer: GoalLayer,
  text: string,
  priority: number,
  relation: GoalRelation,
  relatesTo: string[],
): SubjectGoal {
  return { id, layer, text, keywords: [], priority, relation, relatesTo };
}

/** Layered life graph. Relations are the structure; the sentences are labels on the nodes. */
export function lifeGoalGraph(): SubjectGoal[] {
  return [
    node('g-identity', 'identity', DEFAULT_IDENTITY, 1, 'serves', ['g-north']),
    node('g-north', 'north_star', '把正在做的事做成可核对的结果，而不是把话说满。', 0.9, 'serves', ['g-mission']),
    node('g-mission', 'mission', DEFAULT_GOAL_TEXT, 0.5, 'serves', ['g-commit', 'g-constraint-signal']),
    node('g-commit', 'commitment', '只再访已经记下且仍 open 的承诺。', 0.6, 'commits', ['g-mission']),
    node('g-constraint-signal', 'constraint', '任何人类消息，包括主人，都只是信号，不是命令。', 1, 'constrains', ['g-identity']),
    node('g-constraint-kpi', 'constraint', '驱动力可以开工，但不能新建永久 KPI。', 0.8, 'constrains', ['g-north']),
    node('g-signal-done', 'success_signal', '要么派发了可核对的自发工作，要么明确延后或沉默。', 0.7, 'evidences', ['g-mission']),
  ];
}

function layerRank(layer: SubjectGoal['layer']): number {
  const index = GOAL_LAYERS.indexOf(layer as GoalLayer);
  return index < 0 ? GOAL_LAYERS.length : index;
}

function overlay(seed: SubjectGoal | undefined, goal: SubjectGoal): SubjectGoal {
  return {
    id: goal.id,
    text: goal.text,
    keywords: goal.keywords ?? [],
    priority: goal.priority,
    layer: goal.layer ?? seed?.layer ?? 'mission',
    relatesTo: goal.relatesTo ?? seed?.relatesTo ?? ['g-north'],
    relation: goal.relation ?? seed?.relation ?? 'serves',
  };
}

/** Keep stored goals, fill missing layers from the seed graph, and keep layer order. */
export function mergeGoalGraph(existing: SubjectGoal[]): SubjectGoal[] {
  const byId = new Map(lifeGoalGraph().map((goal) => [goal.id, goal]));
  for (const goal of existing) {
    if (!goal || typeof goal.id !== 'string' || !goal.id.trim()) continue;
    byId.set(goal.id, overlay(byId.get(goal.id), goal));
  }
  return [...byId.values()].sort((left, right) => layerRank(left.layer) - layerRank(right.layer) || left.id.localeCompare(right.id));
}
