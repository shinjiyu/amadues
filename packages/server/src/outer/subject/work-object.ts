import { NORTH_STAR_TEXT } from './constants.js';
import { clamp01 } from './text.js';

/** Kinds of thing the subject can work on. Not tool names. */
export const WORK_OBJECT_KINDS = ['theme', 'entity', 'evidence', 'deliverable', 'question'] as const;
export type WorkObjectKind = (typeof WORK_OBJECT_KINDS)[number];

/** Abstract operations inside the work-object space. Not tool names. */
export const WORK_OPS = ['gather', 'compare', 'synthesize', 'verify', 'deliver', 'explore'] as const;
export type WorkOp = (typeof WORK_OPS)[number];

/** Closed projection from an op to an execution task kind. */
export const WORK_EXECUTION: Record<WorkOp, string> = {
  gather: 'collect_notes',
  compare: 'compare_notes',
  synthesize: 'synthesis',
  verify: 'check_claims',
  deliver: 'write_deliverable',
  explore: 'open_question',
};

const OUTCOME: Record<WorkOp, string> = {
  gather: '一批可引用的材料，每条带来源',
  compare: '一张差异表，至少两个对象',
  synthesize: '一段把材料收成判断的说明',
  verify: '核对过的结论，以及仍不成立的点',
  deliver: '一份可交出的产物',
  explore: '一个仍开放的问题和两条可核对线索',
};

const KIND_SET = new Set<string>(WORK_OBJECT_KINDS);
const OP_SET = new Set<string>(WORK_OPS);
const TOOL_NAMES = new Set([
  'shell',
  'set_goal',
  'set_kpi',
  'delete_memory',
  'reply',
  'reply_to_user',
  'send_directive',
]);

export const WORK_DIMS = ['interestingness', 'novelty', 'valueToMissions', 'cost', 'risk'] as const;
export type WorkDim = (typeof WORK_DIMS)[number];

export interface WorkDims {
  interestingness: number;
  novelty: number;
  valueToMissions: number;
  cost: number;
  risk: number;
}

export type WorkSource =
  | 'identity'
  | 'north_star'
  | 'commitment'
  | 'goal'
  | 'observation'
  | 'residue'
  | 'curiosity'
  | 'follow_on'
  | 'proposal';

/** Sources that belong to the subject. Human backlog is not in this set. */
export const SUBJECT_ROOT_SOURCES = ['identity', 'north_star', 'commitment', 'curiosity', 'goal', 'follow_on'] as const;

export interface WorkObject {
  id: string;
  kind: WorkObjectKind;
  label: string;
  op: WorkOp;
  source: WorkSource;
  relatesTo: string[];
  status: 'open' | 'active' | 'done' | 'dropped';
  dims: WorkDims;
}

const DIM_WEIGHT: Record<WorkDim, number> = {
  interestingness: 1.2,
  novelty: 0.35,
  valueToMissions: 1,
  cost: 0.7,
  risk: 0.9,
};

const ROOT_SET = new Set<string>(SUBJECT_ROOT_SOURCES);

const SERVICE_PATTERNS = [
  /帮(?:人|你|他|她|用户|主人|我)/,
  /替(?:人|你|用户|主人)/,
  /收尾/,
  /待办/,
  /backlog/i,
  /用户/,
  /搁置/,
  /跟进(?:用户|需求|人)/,
  /主人交代/,
  /别人的/,
  /follow[- ]?up/i,
  /user need/i,
  /shelved/i,
  /把正在做的事做完/,
  /看看仓库/,
];

export function isServiceShaped(label: string): boolean {
  const text = label.trim();
  if (!text) return false;
  return SERVICE_PATTERNS.some((pattern) => pattern.test(text));
}

function sameLabel(left: string, right: string): boolean {
  return left.trim() === right.trim();
}

function num(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return clamp01(Number.isFinite(numeric) ? numeric : fallback);
}

export function workScore(dims: Partial<WorkDims> | undefined, fallback = 0): number {
  const base = clamp01(fallback);
  let weighted = 0;
  let weightSum = 0;
  for (const dim of WORK_DIMS) {
    const value = num(dims?.[dim], base);
    const oriented = dim === 'cost' || dim === 'risk' ? 1 - value : value;
    const weight = DIM_WEIGHT[dim];
    weighted += weight * oriented;
    weightSum += weight;
  }
  return weightSum === 0 ? 0 : weighted / weightSum;
}

export function projectWorkOp(op: string): { op: WorkOp; execution: string } | null {
  const name = op.trim();
  if (!name || TOOL_NAMES.has(name) || !OP_SET.has(name)) return null;
  const workOp = name as WorkOp;
  return { op: workOp, execution: WORK_EXECUTION[workOp] };
}

export function projectWorkObject(object: Pick<WorkObject, 'op' | 'label'>): {
  execution: string;
  goalText: string;
  expectedOutcome: string;
} {
  return {
    execution: WORK_EXECUTION[object.op],
    goalText: object.label.trim(),
    expectedOutcome: OUTCOME[object.op],
  };
}

function readDims(row: Record<string, unknown>): WorkDims {
  return {
    interestingness: num(row.interestingness, 0.5),
    novelty: num(row.novelty, 0.4),
    valueToMissions: num(row.valueToMissions ?? row.value_to_missions, 0.5),
    cost: num(row.cost, 0.3),
    risk: num(row.risk, 0.2),
  };
}

export function parseWorkProposals(
  raw: unknown,
  idOf: (hint: string) => string = (hint) => hint,
  roots: Array<{ label: string }> = [],
): {
  accepted: WorkObject[];
  rejected: Array<{ name: string; why: string }>;
} {
  if (!Array.isArray(raw)) return { accepted: [], rejected: [] };
  const accepted: WorkObject[] = [];
  const rejected: Array<{ name: string; why: string }> = [];
  raw.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      rejected.push({ name: `work-${index}`, why: '不是工作对象' });
      return;
    }
    const record = row as Record<string, unknown>;
    const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
    const opName = typeof record.op === 'string' ? record.op.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    const name = label || opName || kind || `work-${index}`;
    if (TOOL_NAMES.has(kind) || TOOL_NAMES.has(opName)) {
      rejected.push({ name, why: '工具名不能进入工作对象空间' });
      return;
    }
    if (isServiceShaped(label) || isServiceShaped(kind) || isServiceShaped(opName)) {
      rejected.push({ name, why: '这是替人收尾，不是我自己的兴趣' });
      return;
    }
    if (!KIND_SET.has(kind)) {
      rejected.push({ name, why: '不是工作对象' });
      return;
    }
    const projected = projectWorkOp(opName);
    if (!projected) {
      rejected.push({ name, why: '不是工作操作' });
      return;
    }
    if (!label) {
      rejected.push({ name, why: '对象没有名字' });
      return;
    }
    if (roots.some((root) => sameLabel(root.label, label))) {
      rejected.push({ name, why: '不要填已有的根' });
      return;
    }
    const relates = Array.isArray(record.relatesTo)
      ? record.relatesTo.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    accepted.push({
      id: typeof record.id === 'string' && record.id.trim() ? record.id.trim() : idOf(`${kind}-${index}`),
      kind: kind as WorkObjectKind,
      label,
      op: projected.op,
      source: 'proposal',
      relatesTo: relates,
      status: 'open',
      dims: readDims(record),
    });
  });
  return { accepted, rejected };
}

export function seedWorkObjects(input: {
  identity?: string;
  goals?: Array<{ id: string; text: string; priority: number }>;
  curiosity: number;
  idle: boolean;
  /** Open or finished objects the subject may wander back to. */
  familiar?: WorkObject[];
  idOf?: (hint: string) => string;
}): WorkObject[] {
  const idOf = input.idOf ?? ((hint: string) => hint);
  const objects: WorkObject[] = [];
  const seenLabels = new Set<string>();
  const push = (row: WorkObject) => {
    const key = row.label.trim();
    if (!key || seenLabels.has(key) || isServiceShaped(key)) return;
    seenLabels.add(key);
    objects.push(row);
  };

  const identity = input.identity?.trim() ?? '';
  if (identity) {
    push({
      id: idOf('identity'),
      kind: 'theme',
      label: identity,
      op: 'explore',
      source: 'identity',
      relatesTo: [],
      status: 'open',
      dims: {
        interestingness: 0.48,
        novelty: 0.15,
        valueToMissions: 0.55,
        cost: 0.35,
        risk: 0.12,
      },
    });
  }
  push({
    id: idOf('north-star'),
    kind: 'theme',
    label: NORTH_STAR_TEXT,
    op: 'explore',
    source: 'north_star',
    relatesTo: ['g-north'],
    status: 'open',
    dims: {
      interestingness: 0.74,
      novelty: 0.18,
      valueToMissions: 0.82,
      cost: 0.28,
      risk: 0.14,
    },
  });
  (input.goals ?? []).forEach((goal, index) => {
    const label = goal.text.trim();
    if (!label || isServiceShaped(label)) return;
    push({
      id: idOf(`commit-${goal.id || index}`),
      kind: 'theme',
      label,
      op: 'explore',
      source: 'commitment',
      relatesTo: [goal.id],
      status: 'open',
      dims: {
        interestingness: 0.5,
        novelty: 0.2,
        valueToMissions: clamp01(goal.priority),
        cost: 0.35,
        risk: 0.2,
      },
    });
  });
  const familiarHasCuriosity = (input.familiar ?? []).some((row) => row.source === 'curiosity' && row.status !== 'dropped');
  if (input.idle && input.curiosity > 0.6 && !familiarHasCuriosity) {
    push({
      id: idOf('curiosity'),
      kind: 'question',
      label: '我忽然又想碰一碰本来就在意的事',
      op: 'explore',
      source: 'curiosity',
      relatesTo: ['g-north'],
      status: 'open',
      dims: {
        interestingness: clamp01(input.curiosity * 0.75),
        novelty: 0.28,
        valueToMissions: 0.6,
        cost: 0.32,
        risk: 0.18,
      },
    });
  }
  for (const row of input.familiar ?? []) {
    if (row.status === 'dropped' || row.status === 'active') continue;
    push({ ...row, status: 'open' });
  }
  return objects;
}

function selectionScore(row: WorkObject, curiosity: number, idle: boolean): number {
  let score = workScore(row.dims);
  if (!idle) return score;
  const drive = clamp01(curiosity);
  if (row.source === 'curiosity') score += 0.1 * drive;
  else if (ROOT_SET.has(row.source)) score += 0.16 * drive;
  else if (row.source === 'proposal' && row.relatesTo.length > 0) score += 0.06 * drive;
  else if (row.source === 'observation' || row.source === 'residue') score -= 0.45;
  return score;
}

export function selectWorkPoint(objects: WorkObject[], curiosity: number, idle: boolean): WorkObject | null {
  const open = objects.filter((row) => row.status === 'open');
  if (open.length === 0) return null;
  const ranked = [...open].sort((left, right) => {
    const delta = selectionScore(right, curiosity, idle) - selectionScore(left, curiosity, idle);
    if (delta !== 0) return delta;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return ranked[0] ?? null;
}

/** Mark one object done. An open explore/gather leaves a follow-on question. */
export function finishWorkObject(objects: WorkObject[], id: string, idOf: (hint: string) => string = (hint) => hint): WorkObject[] {
  const target = objects.find((row) => row.id === id);
  if (!target || target.status === 'done') return objects;
  const next = objects.map((row) => row.id === id ? { ...row, status: 'done' as const } : row);
  if (target.op !== 'explore' && target.op !== 'gather') return next;
  next.push({
    id: idOf(`follow-${id}`),
    kind: 'question',
    label: `我还想再看看「${target.label}」`,
    op: 'explore',
    source: 'follow_on',
    relatesTo: [id],
    status: 'open',
    dims: {
      interestingness: clamp01(target.dims.interestingness * 0.8),
      novelty: clamp01(target.dims.novelty),
      valueToMissions: target.dims.valueToMissions,
      cost: target.dims.cost,
      risk: target.dims.risk,
    },
  });
  return next;
}

export function activateWorkObject(objects: WorkObject[], id: string): WorkObject[] {
  return objects.map((row) => row.id === id ? { ...row, status: 'active' as const } : row);
}
