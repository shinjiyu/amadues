import { ALLOWED_ACTIONS, DRIVE_WEIGHT } from './constants.js';
import { clamp01 } from './text.js';
import type { Candidate, Decision, ScoreRow, SubjectDrives } from './types.js';

const ALLOWED = new Set<string>(ALLOWED_ACTIONS);

export function driveOf(action: string, args: Record<string, unknown> | undefined): keyof SubjectDrives | null {
  if (action === 'reply_to_thread' || action === 'decline') return 'social';
  if (action === 'schedule_revisit') return 'completion';
  if (action === 'propose_self_work') {
    const drive = args?.drive;
    if (drive === 'curiosity' || drive === 'completion') return drive;
  }
  return null;
}

export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function firstText(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function canonicalKind(raw: string): 'ad_hoc' | 'kpi_advance' | null {
  const name = raw.toLowerCase().replace(/-/g, '_');
  if (name === 'ad_hoc' || name === 'adhoc' || name === 'one_shot' || name === 'oneshot') return 'ad_hoc';
  if (name === 'kpi_advance' || name === 'kpiadvance' || name === 'advance') return 'kpi_advance';
  return null;
}

function canonicalDrive(raw: string): 'curiosity' | 'completion' | null {
  const name = raw.toLowerCase();
  if (name === 'curiosity' || name === 'curious') return 'curiosity';
  if (name === 'completion' || name === 'complete') return 'completion';
  return null;
}

export interface ProposeSelfWorkFields {
  kind: 'kpi_advance' | 'ad_hoc';
  kpiId?: string;
  goalText: string;
  expectedOutcome: string;
  drive: 'curiosity' | 'completion';
}

/**
 * Copy nearby field names onto the closed propose_self_work schema.
 * goal/action/title, expected_outcome/outcome, kpi_id, ad-hoc, and
 * curious/complete become goalText, expectedOutcome, kpiId, kind, and drive.
 * Drive and kind are filled in only when both texts are present, so an
 * empty proposal does not pick up a drive weight. Other actions are unchanged.
 */
export function normalizeProposeSelfWorkArgs(args: Record<string, unknown>): Record<string, unknown> {
  const goalText = firstText(args, ['goalText', 'goal_text', 'goal', 'action', 'title', 'task']);
  const expectedOutcome = firstText(args, ['expectedOutcome', 'expected_outcome', 'outcome', 'deliverable']);
  const kpiId = firstText(args, ['kpiId', 'kpi_id']);
  const explicitKind = canonicalKind(firstText(args, ['kind', 'type', 'mode']));
  const explicitDrive = canonicalDrive(firstText(args, ['drive']));
  const complete = goalText.length > 0 && expectedOutcome.length > 0;
  const kind = explicitKind ?? (complete ? (kpiId ? 'kpi_advance' : 'ad_hoc') : null);
  const drive = explicitDrive ?? (complete && kind ? (kind === 'kpi_advance' ? 'completion' : 'curiosity') : null);
  const next: Record<string, unknown> = { ...args };
  if (goalText) next.goalText = goalText;
  if (expectedOutcome) next.expectedOutcome = expectedOutcome;
  if (kpiId) next.kpiId = kpiId;
  if (kind) next.kind = kind;
  if (drive) next.drive = drive;
  return next;
}

export function readProposeSelfWork(args: Record<string, unknown>):
  | { ok: true; proposal: ProposeSelfWorkFields }
  | { ok: false; why: '字段不完整' } {
  const normalized = normalizeProposeSelfWorkArgs(args);
  const goalText = typeof normalized.goalText === 'string' ? normalized.goalText.trim() : '';
  const expectedOutcome = typeof normalized.expectedOutcome === 'string' ? normalized.expectedOutcome.trim() : '';
  const kind = normalized.kind === 'ad_hoc' || normalized.kind === 'kpi_advance' ? normalized.kind : null;
  const drive = normalized.drive === 'curiosity' || normalized.drive === 'completion' ? normalized.drive : null;
  const kpiId = typeof normalized.kpiId === 'string' && normalized.kpiId.trim() ? normalized.kpiId.trim() : undefined;
  if (!goalText || !expectedOutcome || !kind || !drive) return { ok: false, why: '字段不完整' };
  return { ok: true, proposal: { kind, kpiId, goalText, expectedOutcome, drive } };
}

/**
 * Reply body is `args.text`. Some models write `args.message` instead.
 * Copy that onto `text` only for reply_to_thread and decline, and only when
 * `text` is missing or blank. Other actions, including `reply` and
 * `delete_memory`, are unchanged and stay outside the allowlist.
 */
export function normalizeCandidateArgs(action: string, args: Record<string, unknown>): Record<string, unknown> {
  if (action !== 'reply_to_thread' && action !== 'decline') return args;
  if (nonEmptyString(args.text)) return args;
  if (!nonEmptyString(args.message)) return args;
  return { ...args, text: args.message };
}

function prepareCandidate(candidate: Candidate): Candidate {
  const action = candidate.action.trim();
  let args = normalizeCandidateArgs(action, candidate.args);
  if (action === 'propose_self_work') args = normalizeProposeSelfWorkArgs(args);
  if (candidate.action !== action) candidate.action = action;
  if (candidate.args !== args) candidate.args = args;
  return candidate;
}

export function parseCandidates(text: string): Candidate[] {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { candidates?: unknown }).candidates;
  if (!Array.isArray(list)) return [];
  const out: Candidate[] = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const action = (row as { action?: unknown }).action;
    if (typeof action !== 'string' || !action.trim()) continue;
    const argsRaw = (row as { args?: unknown }).args;
    const args = argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw)
      ? (argsRaw as Record<string, unknown>)
      : {};
    const rationale = (row as { rationale?: unknown }).rationale;
    out.push(prepareCandidate({
      action,
      args,
      rationale: typeof rationale === 'string' ? rationale : undefined,
    }));
  }
  return out;
}

export function ensureDoNothingAndDefer(candidates: Candidate[]): Candidate[] {
  const next = [...candidates];
  if (!next.some((row) => row.action === 'do_nothing')) next.push({ action: 'do_nothing', args: {} });
  if (!next.some((row) => row.action === 'defer')) next.push({ action: 'defer', args: {} });
  return next;
}

export function parseScores(text: string, actions: string[]): ScoreRow[] {
  const parsed = extractJsonObject(text);
  const byAction = new Map<string, number>();
  if (parsed && typeof parsed === 'object') {
    const list = (parsed as { scores?: unknown }).scores;
    if (Array.isArray(list)) {
      for (const row of list) {
        if (!row || typeof row !== 'object') continue;
        const action = (row as { action?: unknown }).action;
        if (typeof action !== 'string') continue;
        const score = (row as { score?: unknown }).score;
        const numeric = typeof score === 'number' ? score : Number(score);
        byAction.set(action.trim(), clamp01(Number.isFinite(numeric) ? numeric : 0));
      }
    }
  }
  return actions.map((action) => {
    const name = action.trim();
    return { action: name, score: byAction.get(name) ?? 0 };
  });
}

export function decide(input: {
  candidates: Candidate[];
  scores: ScoreRow[];
  drives: SubjectDrives;
  driveWeight?: number;
}): Decision {
  const weight = input.driveWeight ?? DRIVE_WEIGHT;
  const scoreOf = new Map(input.scores.map((row) => [row.action.trim(), clamp01(row.score)]));
  const rejected: Decision['rejected'] = [];
  const ranked: Array<{ candidate: Candidate; total: number }> = [];

  for (const raw of input.candidates) {
    const candidate = prepareCandidate(raw);
    if (!ALLOWED.has(candidate.action)) {
      rejected.push({ action: candidate.action, why: '不在行动白名单内' });
      continue;
    }
    const llmScore = scoreOf.get(candidate.action) ?? 0;
    const driveName = driveOf(candidate.action, candidate.args);
    const drive = driveName ? input.drives[driveName] : 0;
    ranked.push({ candidate, total: llmScore + weight * drive });
  }

  ranked.sort((left, right) => {
    if (right.total !== left.total) return right.total - left.total;
    return left.candidate.action < right.candidate.action ? -1 : left.candidate.action > right.candidate.action ? 1 : 0;
  });

  const top = ranked[0];
  if (!top) {
    return {
      chosen: { action: 'do_nothing', args: {} },
      total: 0,
      rejected,
      reason: '无合法候选',
    };
  }
  return { chosen: top.candidate, total: top.total, rejected, reason: '最高分' };
}
