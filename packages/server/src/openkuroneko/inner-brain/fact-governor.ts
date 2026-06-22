/**
 * Fact Governor — supersede-on-write, eviction sweep, prompt selection.
 *
 * ADL：doc/structurizr/FACTS-KNOWLEDGE-GOVERNANCE.md §4–6
 */

import crypto from 'node:crypto';

import { reconcileFactConflicts } from './fact-conflict.js';
import { deriveFactTopic } from './fact-topic.js';
import type { FactConfidence, FactConflictEntry, FactRecord, FactSource } from './types.js';

export interface FactGovernorWeights {
  cite: number;
  conf: number;
  recency: number;
  age: number;
  contra: number;
}

export const DEFAULT_FACT_WEIGHTS: FactGovernorWeights = {
  cite: 2,
  conf: 1,
  recency: 1,
  age: 0.05,
  contra: 5,
};

export interface RecordFactInput {
  content: string;
  topic?: string;
  confidence?: FactConfidence;
  tags?: string[];
  source?: Partial<FactSource>;
}

export type RecordFactAction = 'created' | 'superseded' | 'bumped' | 'skipped';

export interface RecordFactResult {
  records: FactRecord[];
  action: RecordFactAction;
  record?: FactRecord;
}

export interface SweepFactsOptions {
  maxActive?: number;
  headroomRatio?: number;
  coldDays?: number;
  weights?: FactGovernorWeights;
  now?: Date;
}

export interface SweepFactsResult {
  superseded: { id: string; reason: 'cold' | 'quota' | 'stale_status' }[];
  remainingActive: number;
  conflicts: FactConflictEntry[];
}

export interface SelectFactsOptions {
  max?: number;
  now?: Date;
  weights?: FactGovernorWeights;
}

export interface PromptFactsResult {
  lines: string[];
  omitted: number;
  section: string;
}

export function factIdFromContent(content: string): string {
  const norm = content.replace(/\s+/g, ' ').trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12);
  return `kn-${hash}`;
}

function confScore(c: FactConfidence): number {
  if (c === 'verified') return 3;
  if (c === 'hypothesis') return 1;
  return 0;
}

function ageDays(at: string, now: Date): number {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now.getTime() - t) / (24 * 3600 * 1000));
}

function recencyBoost(lastCitedAt: string | undefined, now: Date): number {
  if (!lastCitedAt) return 0;
  const days = ageDays(lastCitedAt, now);
  return days < 1 ? 1 : 1 / days;
}

export function scoreFact(
  f: FactRecord,
  now: Date = new Date(),
  weights: FactGovernorWeights = DEFAULT_FACT_WEIGHTS,
): number {
  const age = ageDays(f.source.at, now);
  return (
    weights.cite * f.citeCount +
    weights.conf * confScore(f.confidence) +
    weights.recency * recencyBoost(f.lastCitedAt, now) -
    weights.age * age -
    weights.contra * (f.needsReconcile ? 1 : 0)
  );
}

export function migrateLegacyFacts(facts: string[], at?: string): FactRecord[] {
  const now = at ?? new Date().toISOString();
  return facts
    .map(f => f.trim())
    .filter(Boolean)
    .map(content => ({
      id: factIdFromContent(content),
      topic: deriveFactTopic(content),
      content,
      status: 'active' as const,
      confidence: 'hypothesis' as const,
      source: { at: now, via: 'seed' as const },
      citeCount: 0,
      tags: [] as string[],
    }));
}

export function syncLegacyFactsArray(records: FactRecord[]): string[] {
  return records.filter(r => r.status === 'active').map(r => r.content);
}

export function getActiveFactRecords(records: FactRecord[]): FactRecord[] {
  return records.filter(r => r.status === 'active');
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function norm(text: string): string {
  return normalizeContent(text).toLowerCase();
}

const FACT_STOP = new Set([
  '的', '了', '在', '是', '和', '或', '与', '等', '及', 'the', 'a', 'an', 'to', 'of', 'for', 'in', 'on',
]);

function tokenizeFact(text: string): Set<string> {
  const words = new Set<string>();
  for (const w of norm(text).split(/[\s,，、；;:：\-_/\\[\]()（）]+/)) {
    if (w.length > 1 && !FACT_STOP.has(w)) words.add(w);
  }
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    const gram = cjk.slice(i, i + 2);
    if (!FACT_STOP.has(gram)) words.add(gram);
  }
  return words;
}

export function factContentSimilarity(a: string, b: string): number {
  const wa = tokenizeFact(a);
  const wb = tokenizeFact(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) {
    if (wb.has(w)) shared += 1;
  }
  return shared / Math.max(wa.size, wb.size);
}

function findSimilarActiveFact(records: FactRecord[], content: string, threshold = 0.62): FactRecord | null {
  let best: FactRecord | null = null;
  let bestScore = 0;
  for (const r of records) {
    if (r.status !== 'active') continue;
    const score = factContentSimilarity(content, r.content);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= threshold ? best : null;
}

export function recordFactGoverned(
  records: FactRecord[],
  input: RecordFactInput,
  now: Date = new Date(),
): RecordFactResult {
  const content = normalizeContent(input.content);
  if (!content) return { records, action: 'skipped' };

  const at = input.source?.at ?? now.toISOString();
  const id = factIdFromContent(content);
  const topic = (input.topic?.trim() || deriveFactTopic(content)).toLowerCase();
  const confidence = input.confidence ?? 'hypothesis';
  const tags = input.tags ?? [];

  const exact = records.find(r => r.status === 'active' && factIdFromContent(r.content) === id);
  if (exact) {
    exact.citeCount += 1;
    exact.lastCitedAt = at;
    return { records, action: 'bumped', record: exact };
  }

  const sameTopic = records.find(r => r.status === 'active' && r.topic === topic);
  const similar = sameTopic ? null : findSimilarActiveFact(records, content);
  const toReplace = sameTopic ?? similar;
  const source: FactSource = {
    burstId: input.source?.burstId,
    nodeInstId: input.source?.nodeInstId,
    at,
    via: input.source?.via ?? 'record_fact',
  };

  const next: FactRecord = {
    id,
    topic,
    content,
    status: 'active',
    confidence,
    source,
    citeCount: 0,
    lastCitedAt: at,
    tags,
    ...(toReplace ? { supersedes: toReplace.id } : {}),
  };

  const out = [...records];
  if (toReplace) {
    const idx = out.findIndex(r => r.id === toReplace.id);
    if (idx >= 0) out[idx] = { ...out[idx]!, status: 'superseded' };
    out.push(next);
    return { records: out, action: 'superseded', record: next };
  }

  out.push(next);
  return { records: out, action: 'created', record: next };
}

export function sweepFacts(
  records: FactRecord[],
  opts: SweepFactsOptions = {},
): { records: FactRecord[]; result: SweepFactsResult } {
  const max =
    opts.maxActive ?? (Number(process.env['INNER_FACTS_MAX_ACTIVE'] ?? 60) || 60);
  const headroom = opts.headroomRatio ?? 0.2;
  const coldDays =
    opts.coldDays ?? (Number(process.env['INNER_FACTS_COLD_DAYS'] ?? 14) || 14);
  const weights = opts.weights ?? DEFAULT_FACT_WEIGHTS;
  const now = opts.now ?? new Date();

  const reconciled = reconcileFactConflicts(records, now);
  const out = reconciled.records.map(r => ({ ...r }));
  const superseded: SweepFactsResult['superseded'] = reconciled.staleStatusSuperseded.map(id => ({
    id,
    reason: 'stale_status' as const,
  }));

  const markSuperseded = (id: string, reason: 'cold' | 'quota') => {
    const idx = out.findIndex(r => r.id === id);
    if (idx < 0 || out[idx]!.status !== 'active') return;
    out[idx] = { ...out[idx]!, status: 'superseded' };
    superseded.push({ id, reason });
  };

  for (const r of out) {
    if (r.status !== 'active') continue;
    if (r.confidence === 'verified') continue;
    if (r.citeCount > 0) continue;
    if (ageDays(r.source.at, now) <= coldDays) continue;
    markSuperseded(r.id, 'cold');
  }

  const target = Math.floor(max * (1 - headroom));
  if (out.filter(r => r.status === 'active').length > max) {
    while (out.filter(r => r.status === 'active').length > target) {
      const active = out.filter(r => r.status === 'active');
      const lowest = [...active].sort(
        (a, b) => scoreFact(a, now, weights) - scoreFact(b, now, weights),
      )[0];
      if (!lowest) break;
      markSuperseded(lowest.id, 'quota');
    }
  }

  return {
    records: out,
    result: {
      superseded,
      remainingActive: out.filter(r => r.status === 'active').length,
      conflicts: reconciled.conflicts,
    },
  };
}

/** 压缩 superseded/retracted 历史，避免 memory.json 膨胀 */
export function compactFactRecords(
  records: FactRecord[],
  opts: { maxArchive?: number } = {},
): FactRecord[] {
  const maxArchive = opts.maxArchive ?? 80;
  const active = records.filter(r => r.status === 'active');
  const archive = records.filter(r => r.status !== 'active');
  if (archive.length <= maxArchive) return records;
  const trimmedArchive = archive
    .sort((a, b) => Date.parse(b.source.at) - Date.parse(a.source.at))
    .slice(0, maxArchive);
  return [...active, ...trimmedArchive];
}

export function selectFactsForPrompt(
  records: FactRecord[],
  opts: SelectFactsOptions = {},
): PromptFactsResult {
  const max =
    opts.max ?? (Number(process.env['INNER_FACTS_PROMPT_MAX'] ?? 24) || 24);
  const now = opts.now ?? new Date();
  const weights = opts.weights ?? DEFAULT_FACT_WEIGHTS;

  const active = getActiveFactRecords(records);
  const sorted = [...active].sort((a, b) => {
    const recDiff = (a.needsReconcile ? 1 : 0) - (b.needsReconcile ? 1 : 0);
    if (recDiff !== 0) return recDiff;
    const confDiff = confScore(b.confidence) - confScore(a.confidence);
    if (confDiff !== 0) return confDiff;
    return scoreFact(b, now, weights) - scoreFact(a, now, weights);
  });

  const picked = sorted.slice(0, max);
  const omitted = Math.max(0, sorted.length - picked.length);
  const conflictCount = active.filter(r => r.needsReconcile).length;
  const lines = picked.map(f =>
    f.needsReconcile ? `- ⚠️ [待核实] ${f.content}` : `- ${f.content}`,
  );

  let section = `## 已知事实\n${lines.length ? lines.join('\n') : '（无）'}`;
  if (conflictCount > 0) {
    section += `\n\n（${conflictCount} 条事实存在矛盾标记，优先用 record_fact 写入更新结论并 supersede 旧条）`;
  }
  if (omitted > 0) {
    section += `\n\n（另有 ${omitted} 条事实已省略；可用 read_memory key=fact_records 查看全量）`;
  }

  return { lines, omitted, section };
}
