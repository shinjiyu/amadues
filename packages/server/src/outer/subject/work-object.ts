import { DEFAULT_GOAL_TEXT, DEFAULT_IDENTITY, DESCRIBE_TASK, NORTH_STAR_TEXT } from './constants.js';
import { extractJsonObject } from './decide.js';
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

/** Echoes of the retired per-op sentences. They are not dispatched. */
const CANNED_OUTCOMES = [
  '一批可引用的材料，每条带来源',
  '一张差异表，至少两个对象',
  '一段把材料收成判断的说明',
  '核对过的结论，以及仍不成立的点',
  '一份可交出的产物',
  '一个仍开放的问题和两条可核对线索',
];

const CURIOSITY_LABEL = '我忽然又想碰一碰本来就在意的事';

const FILLER_LABELS = new Set([
  NORTH_STAR_TEXT,
  DEFAULT_IDENTITY,
  DEFAULT_GOAL_TEXT,
  CURIOSITY_LABEL,
]);

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
} {
  return {
    execution: WORK_EXECUTION[object.op],
    goalText: object.label.trim(),
  };
}

const ANALYSIS_PATTERNS = [
  /拆开/,
  /探讨/,
  /分析/,
  /反思/,
  /思考/,
  /想想/,
  /想清楚/,
  /想明白/,
  /弄明白/,
  /搞清楚/,
  /搞清/,
  /搞明白/,
  /论述/,
  /写成/,
  /开放式/,
  /琢磨/,
  /沉思/,
  /梳理/,
  /复盘/,
  /研究/,
  /做法/,
  /理解/,
];

const ACTION_MARKERS = ['练习', '训练', '练', '收集', '搜集', '采集', '试试', '尝试', '试', '对战', '战斗', '打一场', '打', '动手', '搭建', '做出', '造', '做'];

function outsideLabel(text: string, label: string): string {
  const name = label.trim();
  if (!name) return text;
  return text.split(name).join('');
}

function isAnalysisShaped(text: string, label: string): boolean {
  const body = outsideLabel(text, label);
  if (!body.trim()) return false;
  return ANALYSIS_PATTERNS.some((pattern) => pattern.test(body));
}

function hasDoableMove(text: string): boolean {
  const body = text.replace(/打算/g, '').replace(/作为/g, '').replace(/做法/g, '');
  return ACTION_MARKERS.some((marker) => body.includes(marker));
}

export function isCannedOutcome(text: string): boolean {
  const body = text.trim();
  if (!body) return false;
  return CANNED_OUTCOMES.some((line) => body === line || body.endsWith(line));
}

export function buildWorkDescribeUser(object: Pick<WorkObject, 'label' | 'kind' | 'op'>): string {
  return `${DESCRIBE_TASK}\n对象：${JSON.stringify({
    label: object.label,
    kind: object.kind,
    op: object.op,
  })}`;
}

export function acceptWorkDescription(
  raw: string,
  object: Pick<WorkObject, 'label'>,
): { ok: true; goalText: string; expectedOutcome: string } | { ok: false; why: string } {
  const label = object.label.trim();
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, why: '产物说明是空的' };
  }
  const record = parsed as Record<string, unknown>;
  const outcome = typeof record.expectedOutcome === 'string' ? record.expectedOutcome.trim() : '';
  if (!outcome) return { ok: false, why: '产物说明是空的' };
  if (isServiceShaped(outcome)) return { ok: false, why: '产物说明是替人收尾' };
  if (isCannedOutcome(outcome)) return { ok: false, why: '产物说明是套话' };
  if (!outcome.includes(label)) return { ok: false, why: '产物说明没有落到这个对象上' };
  if (isAnalysisShaped(outcome, label)) return { ok: false, why: '产物说明是在分析' };
  if (!hasDoableMove(outcome)) return { ok: false, why: '产物说明不是可做的一步' };
  const refined = typeof record.goalText === 'string' ? record.goalText.trim() : '';
  const goalText = refined.includes(label)
    && !isServiceShaped(refined)
    && !isCannedOutcome(refined)
    && !isAnalysisShaped(refined, label)
    && hasDoableMove(refined)
    ? refined
    : outcome;
  return { ok: true, goalText, expectedOutcome: outcome };
}

/** Identity text and the north-star slogan are anchors, not a task to dispatch. */
export function isFillerWork(row: { source: string; label: string }): boolean {
  if (row.source === 'identity' || row.source === 'north_star') return true;
  return FILLER_LABELS.has(row.label.trim());
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
        interestingness: 0.62,
        novelty: 0.18,
        valueToMissions: 0.7,
        cost: 0.3,
        risk: 0.16,
      },
  });
  (input.goals ?? []).forEach((goal, index) => {
    const label = goal.text.trim();
    if (!label || isServiceShaped(label) || FILLER_LABELS.has(label)) return;
    push({
      id: idOf(`commit-${goal.id || index}`),
      kind: 'theme',
      label,
      op: 'explore',
      source: 'commitment',
      relatesTo: [goal.id],
      status: 'open',
      dims: {
        interestingness: 0.82,
        novelty: 0.24,
        valueToMissions: clamp01(Math.max(0.75, goal.priority)),
        cost: 0.26,
        risk: 0.15,
      },
    });
  });
  const familiarHasCuriosity = (input.familiar ?? []).some((row) => row.source === 'curiosity' && row.status !== 'dropped');
  if (input.idle && input.curiosity > 0.6 && !familiarHasCuriosity) {
    push({
      id: idOf('curiosity'),
      kind: 'question',
      label: CURIOSITY_LABEL,
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

function anchorIds(objects: WorkObject[]): Set<string> {
  const ids = new Set<string>();
  for (const row of objects) {
    if (row.status === 'dropped' || isFillerWork(row)) continue;
    if (row.source !== 'commitment' && row.source !== 'goal' && row.source !== 'follow_on') continue;
    ids.add(row.id);
    for (const rel of row.relatesTo) ids.add(rel);
  }
  return ids;
}

function selectionScore(row: WorkObject, curiosity: number, idle: boolean, anchors: Set<string>): number {
  let score = workScore(row.dims);
  const drive = clamp01(curiosity);
  const tied = row.relatesTo.some((id) => anchors.has(id));
  if (isFillerWork(row)) {
    if (idle) score += 0.16 * drive;
  } else if (row.source === 'commitment' || row.source === 'goal' || row.source === 'follow_on') {
    if (idle) score += 0.12 * drive;
  } else if (row.source === 'proposal' && anchors.size > 0 && !tied) score -= 0.22;
  else if (row.source === 'proposal' && tied && idle) score += 0.06 * drive;
  else if (!idle) return score;
  else if (row.source === 'curiosity') score += 0.1 * drive;
  else if (ROOT_SET.has(row.source)) score += 0.16 * drive;
  else if (row.source === 'observation' || row.source === 'residue') score -= 0.45;
  return score;
}

function isConcreteInterest(row: WorkObject): boolean {
  if (isFillerWork(row) || isServiceShaped(row.label)) return false;
  return row.source === 'commitment' || row.source === 'goal' || row.source === 'follow_on' || row.source === 'proposal';
}

export function selectWorkPoint(objects: WorkObject[], curiosity: number, idle: boolean): WorkObject | null {
  const open = objects.filter((row) => row.status === 'open' && !isServiceShaped(row.label));
  if (open.length === 0) return null;
  const lasting = open.filter((row) => isConcreteInterest(row) && row.source !== 'proposal');
  const pool = lasting.length > 0
    ? open.filter((row) => !isFillerWork(row) && row.source !== 'observation' && row.source !== 'residue')
    : open;
  const anchors = anchorIds(objects);
  const ranked = [...pool].sort((left, right) => {
    const delta = selectionScore(right, curiosity, idle, anchors) - selectionScore(left, curiosity, idle, anchors);
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
