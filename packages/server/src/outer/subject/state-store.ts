import fs from 'node:fs';
import path from 'node:path';

import {
  DECAY_ON_ACT,
  DEFAULT_GOAL_TEXT,
  DEFAULT_IDENTITY,
  DEFER_REVISIT_MS,
  DEFERRED_CAP,
  DRIVE_COOLDOWN_MS,
  DRIVE_WEIGHT,
  INBOX_CAP,
  RAW_CODE_POINTS,
  SHORT_TERM_CAP,
  THINK_LOG_LINE_BYTES,
  THINK_THRESHOLD,
} from './constants.js';
import { truncateCodePoints } from './text.js';
import type { InboxItem, SubjectState, ThinkLogRecord } from './types.js';

export function subjectDir(dataRoot: string): string {
  return path.join(dataRoot, 'subject');
}

function statePath(dataRoot: string): string {
  return path.join(subjectDir(dataRoot), 'state.json');
}

function inboxPath(dataRoot: string): string {
  return path.join(subjectDir(dataRoot), 'inbox.json');
}

function logPath(dataRoot: string): string {
  return path.join(subjectDir(dataRoot), 'think-log.jsonl');
}

function atomicWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

export function readGoalSeed(dataRoot: string, nowIso: string): SubjectState['goals'] {
  const file = path.join(dataRoot, 'outer', 'goal.md');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    text = '';
  }
  if (text) {
    return [{ id: 'g-outer', text: truncateCodePoints(text, 500), keywords: [], priority: 0.8 }];
  }
  return [{ id: 'g-default', text: DEFAULT_GOAL_TEXT, keywords: [], priority: 0.5 }];
}

export function createInitialState(dataRoot: string, nowMs: number): SubjectState {
  const nowIso = new Date(nowMs).toISOString();
  return {
    version: 1,
    identity: DEFAULT_IDENTITY,
    goals: readGoalSeed(dataRoot, nowIso),
    drives: { curiosity: 0.3, social: 0.3, completion: 0.3 },
    lastAccruedAt: nowIso,
    accrualPerHour: { curiosity: 0.1, social: 0.06, completion: 0.08 },
    thinkThreshold: THINK_THRESHOLD,
    driveWeight: DRIVE_WEIGHT,
    decayOnAct: DECAY_ON_ACT,
    driveThinkCooldownMs: DRIVE_COOLDOWN_MS,
    lastDriveOnlyThinkAt: null,
    deferRevisitMs: DEFER_REVISIT_MS,
    deferredCap: DEFERRED_CAP,
    shortTerm: [],
    deferred: [],
    lease: null,
  };
}

export function loadState(dataRoot: string, nowMs: number): SubjectState {
  const file = statePath(dataRoot);
  if (!fs.existsSync(file)) return createInitialState(dataRoot, nowMs);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SubjectState;
    if (parsed?.version !== 1 || !parsed.drives) return createInitialState(dataRoot, nowMs);
    return parsed;
  } catch {
    return createInitialState(dataRoot, nowMs);
  }
}

export function saveState(dataRoot: string, state: SubjectState): void {
  atomicWrite(statePath(dataRoot), JSON.stringify(state));
}

export function loadInbox(dataRoot: string): InboxItem[] {
  const file = inboxPath(dataRoot);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as InboxItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveInbox(dataRoot: string, items: InboxItem[]): void {
  atomicWrite(inboxPath(dataRoot), JSON.stringify(items));
}

export function enqueueInbox(dataRoot: string, item: InboxItem): InboxItem[] {
  const next = loadInbox(dataRoot);
  const raw = truncateCodePoints(item.raw, RAW_CODE_POINTS);
  next.push({ ...item, raw });
  const dropped = next.length > INBOX_CAP ? next.length - INBOX_CAP : 0;
  const kept = next.slice(-INBOX_CAP);
  if (dropped > 0) {
    console.log(`[utlra][subject] inbox drop oldest count=${dropped}`);
  }
  saveInbox(dataRoot, kept);
  return kept;
}

export function pushShortTerm(state: SubjectState, row: { at: string; action: string; result: string }): SubjectState {
  return { ...state, shortTerm: [...state.shortTerm, row].slice(-SHORT_TERM_CAP) };
}

export function appendThinkLog(dataRoot: string, record: ThinkLogRecord): void {
  const file = logPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let signals = Array.isArray(record.signals) ? [...record.signals] : [];
  let truncated = false;
  const encode = () => JSON.stringify({ ...record, signals, truncated: truncated || undefined });
  let line = encode();
  while (Buffer.byteLength(line, 'utf8') > THINK_LOG_LINE_BYTES && signals.length > 0) {
    signals.shift();
    truncated = true;
    line = encode();
  }
  fs.appendFileSync(file, `${line}\n`);
}
