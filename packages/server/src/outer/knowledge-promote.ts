/**
 * 内脑 knowledge.md → drive9 /knowledge/shared/ 晋升与 seed（方案 B）
 *
 * 晋升时过滤：Secret 脱敏、超长截断、空行跳过。
 * seed 时写入 workDir/.brain/knowledge.md 供 Executor 每 tick 读取。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeDrive9Store, KnowledgeRecord } from '../drive9/knowledge-drive9-store.js';

const MAX_FACT_CHARS = 2_000;
const SEED_SECTION_HEADER = '## 共享事实（drive9 检索注入）';
const SEED_MARKER = '<!-- drive9-seed -->';

/** 命中则脱敏；脱敏后若几乎只剩占位符则跳过晋升 */
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
    if (!trimmed || trimmed.startsWith(SEED_SECTION_HEADER)) continue;
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

/** 脱敏后若无可读信息量则不应晋升 */
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

/** 从事实文本提取简单 tags（域名、路径片段、英文词） */
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

/**
 * burst 结束：将 .brain/knowledge.md 中 [事实] 晋升到 drive9 shared（fire-and-forget）。
 */
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

  console.log(
    `[utlra][knowledge-promote] drive9 merge: ${queued} 条事实 → /knowledge/shared/ from ${workspaceId}`,
  );
}

/**
 * set_goal：按 goal 从 drive9 检索事实，追加到 workDir/.brain/knowledge.md（供 Executor 使用）。
 */
export async function seedRelevantKnowledgeToWorkDir(
  store: KnowledgeDrive9Store,
  workDir: string,
  goal: string,
  topK = 8,
): Promise<void> {
  const records = await store.searchShared(goal, topK);
  if (records.length === 0) {
    console.log(`[utlra][knowledge-promote] drive9 无相关事实，跳过 seed（${path.basename(workDir)}）`);
    return;
  }

  const brainDir = path.join(workDir, '.brain');
  fs.mkdirSync(brainDir, { recursive: true });
  const knowledgeFile = path.join(brainDir, 'knowledge.md');

  let existing = '';
  if (fs.existsSync(knowledgeFile)) {
    existing = fs.readFileSync(knowledgeFile, 'utf8');
  }

  const blocks: string[] = [];
  if (!existing.includes(SEED_SECTION_HEADER)) {
    blocks.push(
      '',
      SEED_SECTION_HEADER,
      '',
      '> 以下由 drive9 共享知识库按当前 goal 自动注入；请优先参考，避免重复全量探测。',
      '',
    );
  }

  const existingIds = new Set<string>();
  for (const m of existing.matchAll(/^<!--\s*kn-[a-f0-9]{12}\s*-->$/gm)) {
    existingIds.add(m[0].replace(/<!--\s*|\s*-->/g, '').trim());
  }

  for (const rec of records) {
    if (existingIds.has(rec.id)) continue;
    blocks.push(
      SEED_MARKER,
      `<!-- ${rec.id} -->`,
      `<!-- ${rec.ts} -->`,
      rec.content,
      '',
    );
  }

  if (blocks.length === 0) return;

  const merged = (existing.trimEnd() + '\n' + blocks.join('\n')).trimStart() + '\n';
  fs.writeFileSync(knowledgeFile, merged, 'utf8');
  console.log(
    `[utlra][knowledge-promote] drive9 seed: ${records.length} 条事实 → ${path.basename(workDir)}/.brain/knowledge.md`,
  );
}
