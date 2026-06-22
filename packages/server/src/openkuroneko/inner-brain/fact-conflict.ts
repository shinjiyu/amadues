/**
 * Fact conflict detection — cross-topic polarity heuristics (no LLM).
 *
 * ADL：doc/structurizr/FACTS-KNOWLEDGE-GOVERNANCE.md §5.3
 */

import type { FactConflictEntry, FactRecord } from './types.js';

const FACT_STOP = new Set([
  '的', '了', '在', '是', '和', '或', '与', '等', '及', 'the', 'a', 'an', 'to', 'of', 'for', 'in', 'on',
]);

function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

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

function factContentSimilarity(a: string, b: string): number {
  const wa = tokenizeFact(a);
  const wb = tokenizeFact(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) {
    if (wb.has(w)) shared += 1;
  }
  return shared / Math.max(wa.size, wb.size);
}

const POSITIVE =
  /成功|可行|有效|验证通过|已发布|code:0|code=0|已验证|可靠|worked|verified/i;
const NEGATIVE =
  /失败|无法|不能|无效|不可用|禁止|不可靠|未生效|404|-3006|-3\b|undefined.*不能|does not work|failed/i;

const STATUS_TOPIC = 'fanqie.publish.status';

/** 跨 topic 矛盾检测用的粗粒度 domain */
export function deriveFactDomain(topic: string, content: string): string {
  const text = content.toLowerCase();
  if (
    topic.startsWith('fanqie.publish.status') ||
    /chapter_passed|已成功发布|已发布|latest_publish|chapter_passed_num|待发布|正文字数/.test(text)
  ) {
    return 'fanqie.publish.status';
  }
  if (
    topic.startsWith('fanqie.publish.draft') ||
    /newchapter_0|新草稿|draft item|item_id每次|重复使用.*draft|draft.*url/.test(text)
  ) {
    return 'fanqie.publish.draft';
  }
  if (
    topic.startsWith('fanqie.publish.inject') ||
    topic === 'env.browser.inject' ||
    /clipboardevent|__txt_parts|base64.*paste|内容注入|paste.*prosemirror/.test(text)
  ) {
    return 'fanqie.publish.inject';
  }
  if (topic.startsWith('fanqie.publish')) return 'fanqie.publish';
  if (topic.startsWith('fanqie.api') || topic.startsWith('fanqie.app')) return 'fanqie.api';
  if (topic.startsWith('fanqie.ui')) return 'fanqie.ui';
  const base = topic.split('.').slice(0, 2).join('.');
  if (base && !base.startsWith('general')) return base;
  return topic;
}

export function factPolarity(content: string): 'positive' | 'negative' | 'neutral' {
  const neg =
    NEGATIVE.test(content) ||
    /不可用|不可行|无法|不能|禁止/.test(content);
  const pos =
    (POSITIVE.test(content) ||
      (/可用|有效|可行/.test(content) && !/不可用|不可行|无法|不能/.test(content))) &&
    !neg;
  if (pos && neg) return 'neutral';
  if (pos) return 'positive';
  if (neg) return 'negative';
  return 'neutral';
}

function extractFactAnchor(content: string): string | null {
  const ch = /第(\d+)章|ch(\d+)\b|chapter[_\s-]*(\d+)/i.exec(content);
  if (ch) return `ch${ch[1] ?? ch[2] ?? ch[3]}`;
  const sel = /selector[:\s]+([^\s,，]+)|\.([a-z][a-z0-9_-]{2,})/i.exec(content);
  if (sel) return `sel:${(sel[1] ?? sel[2] ?? '').toLowerCase()}`;
  return null;
}

function anchorsCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  return a === b;
}

export function detectFactConflicts(
  records: FactRecord[],
  now: Date = new Date(),
): FactConflictEntry[] {
  const active = records.filter(r => r.status === 'active');
  const conflicts: FactConflictEntry[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      const domainA = deriveFactDomain(a.topic, a.content);
      const domainB = deriveFactDomain(b.topic, b.content);
      if (domainA !== domainB || domainA.startsWith('general')) continue;

      const polA = factPolarity(a.content);
      const polB = factPolarity(b.content);
      if (polA === 'neutral' || polB === 'neutral' || polA === polB) continue;

      const sim = factContentSimilarity(a.content, b.content);
      const anchorA = extractFactAnchor(a.content);
      const anchorB = extractFactAnchor(b.content);
      if (sim < 0.12 && !anchorsCompatible(anchorA, anchorB)) continue;

      const key = [a.id, b.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({
        domain: domainA,
        factIds: [a.id, b.id],
        reason: `polarity:${polA} vs ${polB}${anchorA ? ` anchor:${anchorA}` : ''}`,
        detectedAt: now.toISOString(),
      });
    }
  }
  return conflicts;
}

/** 同 topic 多条 active（迁移期）→ needsReconcile */
export function flagSameTopicDuplicates(records: FactRecord[]): FactRecord[] {
  const byTopic = new Map<string, FactRecord[]>();
  for (const r of records) {
    if (r.status !== 'active') continue;
    const list = byTopic.get(r.topic) ?? [];
    list.push(r);
    byTopic.set(r.topic, list);
  }
  const duplicateIds = new Set<string>();
  for (const [, list] of byTopic) {
    if (list.length <= 1) continue;
    for (const r of list) duplicateIds.add(r.id);
  }
  if (duplicateIds.size === 0) return records;
  return records.map(r => (duplicateIds.has(r.id) ? { ...r, needsReconcile: true } : r));
}

export function applyFactConflictFlags(
  records: FactRecord[],
  conflicts: FactConflictEntry[],
): FactRecord[] {
  const flagged = new Set<string>();
  for (const c of conflicts) {
    for (const id of c.factIds) flagged.add(id);
  }
  return records.map(r => {
    if (r.status !== 'active' || !flagged.has(r.id)) return r;
    return { ...r, needsReconcile: true };
  });
}

/** fanqie.publish.status 多条 active 时保留最新，旧条 supersede */
export function resolveStaleStatusFacts(records: FactRecord[]): {
  records: FactRecord[];
  supersededIds: string[];
} {
  const active = records.filter(r => r.status === 'active' && r.topic === STATUS_TOPIC);
  if (active.length <= 1) return { records, supersededIds: [] };

  const sorted = [...active].sort(
    (a, b) => Date.parse(b.source.at) - Date.parse(a.source.at),
  );
  const keep = sorted[0]!;
  const drop = new Set(sorted.slice(1).map(r => r.id));
  const supersededIds: string[] = [];

  const out = records.map(r => {
    if (!drop.has(r.id)) return r;
    supersededIds.push(r.id);
    return { ...r, status: 'superseded' as const };
  });
  return { records: out, supersededIds };
}

export interface ReconcileFactsResult {
  records: FactRecord[];
  conflicts: FactConflictEntry[];
  staleStatusSuperseded: string[];
}

/** ATTRIBUTE sweep 前/后调用：时序去重 + 矛盾 flag + fact_conflicts[] */
export function reconcileFactConflicts(
  records: FactRecord[],
  now: Date = new Date(),
): ReconcileFactsResult {
  const { records: afterStatus, supersededIds } = resolveStaleStatusFacts(records);
  const conflicts = detectFactConflicts(afterStatus, now);
  let out = applyFactConflictFlags(afterStatus, conflicts);
  out = flagSameTopicDuplicates(out);
  return { records: out, conflicts, staleStatusSuperseded: supersededIds };
}
