/**
 * drive9 `/knowledge/shared/` — 完全共享事实层
 *
 * 写：record_fact → memory.json → sharedFactSink → storeShared（实时）
 * 读：set_goal → searchShared → seedDrive9FactsToMemory
 *
 * ADL: doc/structurizr/DRIVE9-KNOWLEDGE-SHARED.md
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeDrive9Store, KnowledgeRecord } from '../drive9/knowledge-drive9-store.js';
import { createMemoryStore } from '../openkuroneko/inner-brain/memory-store.js';
import type { FactRecord } from '../openkuroneko/inner-brain/types.js';

const MAX_FACT_CHARS = 2_000;

/** 命中则脱敏；脱敏后若几乎只剩占位符则跳过 */
const SECRET_REDACT: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-[a-zA-Z0-9_-]{12,}\b/gi, replacement: 'sk-<redacted>' },
  { pattern: /\bghp_[a-zA-Z0-9]{20,}\b/gi, replacement: 'ghp_<redacted>' },
  { pattern: /\bAKIA[A-Z0-9]{12,}\b/g, replacement: 'AKIA<redacted>' },
  { pattern: /\bcocos_session=[^\s;,'"]+/gi, replacement: 'cocos_session=<keychain>' },
  { pattern: /\b(?:api[_-]?key|apikey)\s*[:=]\s*[^\s;,'"]+/gi, replacement: 'api_key=<redacted>' },
  { pattern: /\bBearer\s+[a-zA-Z0-9._-]{20,}/gi, replacement: 'Bearer <redacted>' },
  { pattern: /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, replacement: 'eyJ<redacted-jwt>' },
];

export interface BrainFactEntry {
  ts: string;
  content: string;
}

export function parseBrainFactEntries(raw: string): BrainFactEntry[] {
  if (!raw.trim()) return [];
  const entries: BrainFactEntry[] = [];
  let currentTs = '';
  for (const line of raw.split('\n')) {
    const tsMatch = line.match(/^<!--\s*(.+?)\s*-->$/);
    if (tsMatch) {
      currentTs = (tsMatch[1] ?? '').trim();
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('## 共享事实')) continue;
    if (trimmed.startsWith('[事实]')) {
      entries.push({
        ts: currentTs || new Date().toISOString(),
        content: trimmed,
      });
    }
  }
  return entries;
}

export function redactSecretsInFact(text: string): string {
  let out = text;
  for (const { pattern, replacement } of SECRET_REDACT) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function shouldSkipFactPromotion(content: string): boolean {
  const stripped = content
    .replace(/\[事实\]\s*/g, '')
    .replace(/<redacted[^>]*>/gi, '')
    .replace(/<keychain>/gi, '')
    .trim();
  return stripped.length < 8;
}

export function truncateFact(content: string, max = MAX_FACT_CHARS): string {
  if (content.length <= max) return content;
  return content.slice(0, max) + '\n…（事实已截断，详见原 workspace 交付物）';
}

export function factIdFromContent(content: string): string {
  const norm = content.replace(/\s+/g, ' ').trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 12);
  return `kn-${hash}`;
}

export function titleFromFact(content: string): string {
  const body = content.replace(/^\[事实\]\s*/, '').trim();
  const oneLine = body.split('\n')[0] ?? body;
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

export function tagsFromFact(content: string, extra: string[] = []): string[] {
  const tags = new Set<string>(['fact', ...extra]);
  const host = content.match(/[a-z0-9][-a-z0-9]*\.[a-z]{2,}/gi) ?? [];
  for (const h of host.slice(0, 3)) tags.add(h.toLowerCase());
  const api = content.match(/\/api\/[A-Za-z0-9_/]+/g) ?? [];
  for (const p of api.slice(0, 2)) tags.add(p.toLowerCase());
  return Array.from(tags).slice(0, 12);
}

export function factEntryToRecord(
  entry: BrainFactEntry,
  opts: { sourceAgentId?: string; workspaceId?: string; extraTags?: string[] },
): KnowledgeRecord | null {
  let content = redactSecretsInFact(entry.content);
  if (shouldSkipFactPromotion(content)) return null;
  content = truncateFact(content);

  const id = factIdFromContent(content);
  return {
    id,
    title: titleFromFact(content),
    tags: tagsFromFact(content, opts.extraTags),
    content,
    ts: entry.ts,
    sourceAgentId: opts.sourceAgentId,
    workspaceId: opts.workspaceId,
  };
}

export function factRecordToKnowledgeRecord(
  fact: Pick<FactRecord, 'id' | 'content' | 'topic' | 'source' | 'tags'>,
  opts: { sourceAgentId?: string; workspaceId?: string; extraTags?: string[] },
): KnowledgeRecord | null {
  const ts = fact.source?.at ?? new Date().toISOString();
  const entry: BrainFactEntry = {
    ts,
    content: fact.content.startsWith('[事实]') ? fact.content : `[事实] ${fact.content}`,
  };
  const extra = [...(fact.tags ?? []), ...(fact.topic ? [fact.topic] : []), ...(opts.extraTags ?? [])];
  const rec = factEntryToRecord(entry, { ...opts, extraTags: extra });
  if (!rec) return null;
  return { ...rec, id: fact.id.startsWith('kn-') ? fact.id : rec.id };
}

/** record_fact 后同步到 drive9 shared（fire-and-forget） */
export function createDrive9FactSyncSink(
  store: KnowledgeDrive9Store,
  sourceAgentId: string,
  workspaceId: string,
): (fact: FactRecord) => void {
  return (fact) => {
    if (fact.status !== 'active') return;
    const record = factRecordToKnowledgeRecord(fact, {
      sourceAgentId,
      workspaceId,
      extraTags: [workspaceId.replace(/^task-/, '')],
    });
    if (record) store.storeShared(record);
  };
}

/**
 * set_goal：从 drive9 shared 检索事实，seed 进 memory.json fact_records。
 */
export async function seedDrive9FactsToMemory(
  store: KnowledgeDrive9Store,
  workDir: string,
  goal: string,
  topK = 8,
): Promise<number> {
  const records = await store.searchShared(goal, topK);
  if (records.length === 0) {
    console.log(`[utlra][knowledge-shared] drive9 无相关事实，跳过 seed（${path.basename(workDir)}）`);
    return 0;
  }

  const memory = createMemoryStore(workDir);
  const existingIds = new Set(
    (memory.read().fact_records ?? []).map((r) => r.id),
  );

  let seeded = 0;
  for (const rec of records) {
    if (existingIds.has(rec.id)) continue;
    const result = memory.recordFact({
      content: rec.content.replace(/^\[事实\]\s*/, '').trim(),
      topic: `drive9.${rec.id}`,
      tags: rec.tags.filter((t) => t !== 'fact'),
      confidence: 'hypothesis',
      source: { via: 'seed', at: rec.ts },
    });
    if (result.action !== 'skipped') {
      existingIds.add(rec.id);
      seeded++;
    }
  }

  if (seeded > 0) {
    console.log(
      `[utlra][knowledge-shared] drive9 seed: ${seeded} 条 → ${path.basename(workDir)}/.brain/memory.json`,
    );
  }
  return seeded;
}

/** @deprecated 使用 seedDrive9FactsToMemory */
export async function seedRelevantKnowledgeToWorkDir(
  store: KnowledgeDrive9Store,
  workDir: string,
  goal: string,
  topK = 8,
): Promise<void> {
  await seedDrive9FactsToMemory(store, workDir, goal, topK);
}

/** @deprecated burst onExit 晋升已退役；事实在 record_fact 时实时同步 drive9 */
export function mergeWorkDirKnowledgeToDrive9(
  store: KnowledgeDrive9Store,
  workDir: string,
  sourceAgentId?: string,
): void {
  const knowledgePath = path.join(workDir, '.brain', 'knowledge.md');
  if (!fs.existsSync(knowledgePath)) return;

  const raw = fs.readFileSync(knowledgePath, 'utf8');
  const entries = parseBrainFactEntries(raw);
  if (entries.length === 0) return;

  const workspaceId = path.basename(workDir);
  let queued = 0;
  const seen = new Set<string>();

  for (const entry of entries) {
    const record = factEntryToRecord(entry, {
      sourceAgentId,
      workspaceId,
      extraTags: [workspaceId.replace(/^task-/, '')],
    });
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    store.storeShared(record);
    queued++;
  }

  if (queued > 0) {
    console.log(
      `[utlra][knowledge-promote] legacy knowledge.md merge: ${queued} 条 → drive9 from ${workspaceId}`,
    );
  }
}

/** @deprecated 见 createDrive9FactSyncSink */
export function mergeMemoryFactsToDrive9(
  store: KnowledgeDrive9Store,
  workDir: string,
  sourceAgentId?: string,
): void {
  const memoryPath = path.join(workDir, '.brain', 'memory.json');
  if (!fs.existsSync(memoryPath)) return;

  let mem: { fact_records?: FactRecord[] };
  try {
    mem = JSON.parse(fs.readFileSync(memoryPath, 'utf8')) as typeof mem;
  } catch {
    return;
  }

  const workspaceId = path.basename(workDir);
  const sink = createDrive9FactSyncSink(store, sourceAgentId ?? 'unknown', workspaceId);
  for (const fact of mem.fact_records ?? []) {
    if (fact.status === 'active' || fact.status == null) sink(fact);
  }
}

/** @deprecated burst onExit 不再调用 */
export function promoteWorkDirFactsToDrive9(
  store: KnowledgeDrive9Store,
  workDir: string,
  sourceAgentId?: string,
): void {
  mergeWorkDirKnowledgeToDrive9(store, workDir, sourceAgentId);
  mergeMemoryFactsToDrive9(store, workDir, sourceAgentId);
}
