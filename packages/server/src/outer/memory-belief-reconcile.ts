/**
 * 用户口头取消/完成 → 信念对账（降权，非删除）
 * @see doc/todo/memory-belief-reconciliation.md MVP
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Memory } from '../mem9/mem9-client.js';

export type BeliefStatus = 'cancelled' | 'completed';

export interface BeliefRevision {
  topic: string;
  status: BeliefStatus;
  validity: number;
  ts: string;
  source: string;
}

export interface BeliefStoreSnapshot {
  revisions: BeliefRevision[];
}

export interface UserBeliefIntent {
  status: BeliefStatus;
  matched: string;
}

export interface BeliefReconcileResult {
  applied: boolean;
  intent?: BeliefStatus;
  topic?: string;
  reason?: string;
}

export const VALIDITY_CANCELLED = 0.15;
export const VALIDITY_COMPLETED = 0.25;
export const DEFAULT_READ_MIN_VALIDITY = 0.3;

const CANCEL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /不要做了|别做了|不用做了|取消(?:掉|了)?|停止(?:吧|了)?/i, label: 'cancel-zh' },
  { re: /\b(?:stop|cancel)\b/i, label: 'cancel-en' },
];

const COMPLETE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /已完成|完成了|做完了|搞定(?:了)?/i, label: 'complete-zh' },
  { re: /\b(?:done|finished)\b/i, label: 'complete-en' },
];

export function parseUserBeliefIntent(text: string): UserBeliefIntent | null {
  const t = text.trim();
  if (!t) return null;
  for (const { re, label } of CANCEL_PATTERNS) {
    const m = t.match(re);
    if (m) return { status: 'cancelled', matched: m[0] ?? label };
  }
  for (const { re, label } of COMPLETE_PATTERNS) {
    const m = t.match(re);
    if (m) return { status: 'completed', matched: m[0] ?? label };
  }
  return null;
}

export function extractBeliefTopic(text: string, intent: UserBeliefIntent): string {
  let rest = text.trim();
  rest = rest.replace(intent.matched, '').trim();
  rest = rest.replace(/^[：:，,。.!！?？\s]+/, '').trim();
  if (rest.length >= 4) return rest.slice(0, 120);
  return text.trim().slice(0, 80);
}

export function validityForStatus(status: BeliefStatus): number {
  return status === 'cancelled' ? VALIDITY_CANCELLED : VALIDITY_COMPLETED;
}

export function memoryValidity(mem: Memory): number {
  const v = mem.metadata?.['validity'];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return 1;
}

export function filterMemoriesByValidity(memories: Memory[], min = DEFAULT_READ_MIN_VALIDITY): Memory[] {
  return memories.filter((m) => memoryValidity(m) >= min);
}

export function formatArchivedBeliefHints(revisions: BeliefRevision[]): string {
  if (revisions.length === 0) return '';
  const recent = revisions.slice(-8);
  const lines = recent.map((r) => {
    const label = r.status === 'cancelled' ? '已取消' : '已完成';
    return `- 曾计划「${r.topic}」（${label} @ ${r.ts.slice(0, 16)}）`;
  });
  return ['### 已修订信念（降权，勿再主动推进）', ...lines].join('\n');
}

export function applyTasksBeliefRevision(
  tasksMarkdown: string,
  topic: string,
  status: BeliefStatus,
  ts: string,
): string {
  const tag = status === 'cancelled' ? 'cancelled' : 'completed';
  const line = `- [${tag}] ${topic}（用户 ${ts.slice(0, 16)}）`;
  const body = tasksMarkdown.trim();
  if (!body || body.startsWith('（暂无')) return line;
  if (body.includes(topic)) {
    const marked = body
      .split('\n')
      .map((ln) => {
        if (!ln.includes(topic)) return ln;
        if (ln.includes('[cancelled]') || ln.includes('[completed]')) return ln;
        return `- [${tag}] ${ln.replace(/^-\s*\[[ x]\]\s*/, '').trim()}（${ts.slice(0, 16)} 修订）`;
      })
      .join('\n');
    return `${line}\n${marked}`;
  }
  return `${line}\n${body}`;
}

export class BeliefRevisionStore {
  private readonly filePath: string;

  constructor(dataRoot: string, agentSid: string) {
    this.filePath = path.join(dataRoot, 'belief', `${agentSid}.json`);
  }

  read(): BeliefStoreSnapshot {
    if (!fs.existsSync(this.filePath)) return { revisions: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as BeliefStoreSnapshot;
      return { revisions: Array.isArray(raw.revisions) ? raw.revisions : [] };
    } catch {
      return { revisions: [] };
    }
  }

  append(revision: BeliefRevision): BeliefStoreSnapshot {
    const snap = this.read();
    snap.revisions.push(revision);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
    return snap;
  }
}

export function reconcileBeliefFromUserMessage(
  text: string,
  userSid: string,
  beliefStore: BeliefRevisionStore | null,
  tasksMarkdown: string,
): { result: BeliefReconcileResult; tasks: string; revisions: BeliefRevision[] } {
  const intent = parseUserBeliefIntent(text);
  if (!intent) {
    return {
      result: { applied: false, reason: 'no_belief_intent' },
      tasks: tasksMarkdown,
      revisions: beliefStore?.read().revisions ?? [],
    };
  }

  const topic = extractBeliefTopic(text, intent);
  const ts = new Date().toISOString();
  const revision: BeliefRevision = {
    topic,
    status: intent.status,
    validity: validityForStatus(intent.status),
    ts,
    source: userSid,
  };

  let revisions = beliefStore?.read().revisions ?? [];
  if (beliefStore) {
    revisions = beliefStore.append(revision).revisions;
  }

  const tasks = applyTasksBeliefRevision(tasksMarkdown, topic, intent.status, ts);

  return {
    result: { applied: true, intent: intent.status, topic },
    tasks,
    revisions,
  };
}
