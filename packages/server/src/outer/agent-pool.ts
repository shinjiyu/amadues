/**
 * Agent 共享池 — 外脑技能池（对齐 openKuroneko agent-pool.ts）
 *
 * 双向技能流动：
 *   启动时：seedRelevantSkillsToWorkDir — 按目标从池中选相关技能注入给内脑 workspace
 *   退出时：mergeWorkDirSkillsToAgentPool — 内脑学到的新技能合并回全局池
 *
 * 池目录：<DATA_ROOT>/agent-pool/.brain/
 *   - skills.md        ← 技能索引（TSV 格式：id\tcategory\ttitle\ttags\tts）
 *   - skills/<cat>/<id>.md ← 技能内容文件
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SkillMemoryStore, SkillRecord } from '../mem9/skill-memory-store.js';
import type { SkillDrive9Store } from '../drive9/skill-drive9-store.js';
import { serializeSkill, deserializeSkill, SHARED_SKILLS_DIR } from '../drive9/skill-drive9-store.js';
import type { KnowledgeDrive9Store } from '../drive9/knowledge-drive9-store.js';
import {
  mergeWorkDirKnowledgeToDrive9,
  seedRelevantKnowledgeToWorkDir,
} from './knowledge-promote.js';

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface SkillEntry {
  id:       string;
  category: string;
  title:    string;
  tags:     string[];
  ts:       string;
}

// ── 常量 ────────────────────────────────────────────────────────────────────

const SKILLS_INDEX_HEADER = '# skills index: id\tcategory\ttitle\ttags\tts\n';

// ── 目录解析 ────────────────────────────────────────────────────────────────

/** Agent 池 .brain 目录：<dataRoot>/agent-pool/.brain */
export function getAgentPoolBrainDir(dataRoot: string): string {
  return path.join(dataRoot, 'agent-pool', '.brain');
}

// ── 索引解析 ────────────────────────────────────────────────────────────────

export function parseSkillIndex(raw: string): SkillEntry[] {
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('//'))
    .map((l) => {
      const [id, category, title, tagsStr, ts] = l.split('\t');
      if (!id || !category || !title) return null;
      return {
        id:       id.trim(),
        category: category.trim(),
        title:    title.trim(),
        tags:     (tagsStr ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        ts:       (ts ?? '').trim(),
      } as SkillEntry;
    })
    .filter((e): e is SkillEntry => e !== null);
}

// ── 相关性选择 ──────────────────────────────────────────────────────────────

/** 简单分词：与 BrainFS 检索一致，用于相关性打分 */
function tokenize(text: string): Set<string> {
  const STOP = new Set(['的', '了', '在', '是', '和', '或', '与', '等', '及', 'the', 'a', 'an', 'to', 'of', 'for', 'in', 'on', 'at', 'by']);
  const words = new Set<string>();
  for (const w of text.toLowerCase().split(/[\s,，、；;:：\-_/\\[\]()（）]+/)) {
    if (w.length > 1 && !STOP.has(w)) words.add(w);
  }
  const cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    const gram = cjk.slice(i, i + 2);
    if (!STOP.has(gram)) words.add(gram);
  }
  return words;
}

/**
 * 从外脑池中按 goal 做相关性选择，返回 topK 条最相关技能。
 * 算法：goal 分词后与每条技能的 title+tags+category 做词重叠打分。
 */
export function selectRelevantSkills(poolBrainDir: string, goal: string, topK = 5): SkillEntry[] {
  const poolIndex = path.join(poolBrainDir, 'skills.md');
  if (!fs.existsSync(poolIndex)) return [];

  const raw     = fs.readFileSync(poolIndex, 'utf8');
  const entries = parseSkillIndex(raw);
  if (entries.length === 0) return [];

  const queryWords = tokenize(goal);
  if (queryWords.size === 0) return entries.slice(0, topK);

  const scored = entries.map((entry) => {
    const entryWords = new Set([
      ...tokenize(entry.title),
      ...entry.tags.flatMap((t) => tokenize(t)),
      ...tokenize(entry.category),
    ]);
    let score = 0;
    for (const w of queryWords) {
      if (entryWords.has(w)) score++;
    }
    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.entry);
}

// ── 启动时注入 ──────────────────────────────────────────────────────────────

/**
 * 创建内脑 workspace 时：按 goal 选择相关技能，将选中技能注入 workDir/.brain/skills。
 * 池不存在或无匹配时跳过（不写入 skills）。
 */
export function seedRelevantSkillsToWorkDir(
  dataRoot: string,
  workDir: string,
  goal: string,
  topK = 5,
): void {
  const poolBrain  = getAgentPoolBrainDir(dataRoot);
  const selected   = selectRelevantSkills(poolBrain, goal, topK);
  if (selected.length === 0) return;

  const poolSkillsDir = path.join(poolBrain, 'skills');
  const workBrain     = path.join(workDir, '.brain');
  fs.mkdirSync(workBrain, { recursive: true });
  const workSkillsDir = path.join(workBrain, 'skills');

  for (const e of selected) {
    const src = path.join(poolSkillsDir, e.category, `${e.id}.md`);
    if (!fs.existsSync(src)) continue;
    const destCat = path.join(workSkillsDir, e.category);
    fs.mkdirSync(destCat, { recursive: true });
    fs.copyFileSync(src, path.join(destCat, `${e.id}.md`));
  }

  const indexLines = [SKILLS_INDEX_HEADER];
  for (const e of selected) {
    indexLines.push([e.id, e.category, e.title, e.tags.join(','), e.ts].join('\t') + '\n');
  }
  fs.writeFileSync(path.join(workBrain, 'skills.md'), indexLines.join(''), 'utf8');

  console.log(`[utlra][agent-pool] seeded ${selected.length} skills → ${path.basename(workDir)}`);
}

// ── 退出时合并 ──────────────────────────────────────────────────────────────

/**
 * 内脑实例完成后：将 workDir/.brain/skills 合并回 agent 池。
 * 按 id 合并：池中无则添加；有则仅当实例 ts 不早于池中时覆盖。
 */
export function mergeWorkDirSkillsToAgentPool(dataRoot: string, workDir: string): void {
  const workBrain    = path.join(workDir, '.brain');
  const workIndexPath = path.join(workBrain, 'skills.md');
  const workSkillsDir = path.join(workBrain, 'skills');

  if (!fs.existsSync(workIndexPath)) return;

  const workEntries = parseSkillIndex(fs.readFileSync(workIndexPath, 'utf8'));
  if (workEntries.length === 0) return;

  const poolBrain    = getAgentPoolBrainDir(dataRoot);
  const poolIndexPath = path.join(poolBrain, 'skills.md');
  const poolSkillsDir = path.join(poolBrain, 'skills');
  fs.mkdirSync(poolBrain, { recursive: true });

  const poolRaw    = fs.existsSync(poolIndexPath) ? fs.readFileSync(poolIndexPath, 'utf8') : '';
  const poolById   = new Map<string, SkillEntry>(
    parseSkillIndex(poolRaw).map((e) => [e.id, e]),
  );

  let merged = 0;
  for (const e of workEntries) {
    const existing = poolById.get(e.id);
    if (existing && e.ts < existing.ts) continue; // 实例版本更旧，不覆盖

    const srcFile = path.join(workSkillsDir, e.category, `${e.id}.md`);
    if (!fs.existsSync(srcFile)) continue;

    const destCat = path.join(poolSkillsDir, e.category);
    fs.mkdirSync(destCat, { recursive: true });
    fs.copyFileSync(srcFile, path.join(destCat, `${e.id}.md`));
    poolById.set(e.id, e);
    merged++;
  }

  const indexLines = [SKILLS_INDEX_HEADER];
  for (const e of poolById.values()) {
    indexLines.push([e.id, e.category, e.title, e.tags.join(','), e.ts].join('\t') + '\n');
  }
  fs.writeFileSync(poolIndexPath, indexLines.join(''), 'utf8');

  console.log(`[utlra][agent-pool] merged ${merged} skills from ${path.basename(workDir)}, pool total=${poolById.size}`);
}

// ── mem9 语义扩展 ────────────────────────────────────────────────────────────

/**
 * 从 mem9 shared:skills 语义检索相关技能，写入 workDir/.brain/skills。
 * 当 SkillMemoryStore 可用时替代本地关键词检索，提供更精准的语义匹配。
 */
export async function seedRelevantSkillsFromMem9(
  skillStore: SkillMemoryStore,
  workDir: string,
  goal: string,
  topK = 5,
): Promise<void> {
  const skills = await skillStore.searchShared(goal, topK);
  if (skills.length === 0) {
    console.log(`[utlra][agent-pool] mem9 无相关技能，跳过 seed（${path.basename(workDir)}）`);
    return;
  }

  const workBrain    = path.join(workDir, '.brain');
  const workSkillsDir = path.join(workBrain, 'skills');
  fs.mkdirSync(workBrain, { recursive: true });

  const indexLines = [SKILLS_INDEX_HEADER];
  for (const skill of skills) {
    const destCat = path.join(workSkillsDir, skill.category);
    fs.mkdirSync(destCat, { recursive: true });
    fs.writeFileSync(
      path.join(destCat, `${skill.id}.md`),
      `# ${skill.title}\n\n> category: ${skill.category} | id: ${skill.id} | ${skill.ts}\n\n${skill.content}\n`,
      'utf8',
    );
    indexLines.push(
      [skill.id, skill.category, skill.title, skill.tags.join(','), skill.ts].join('\t') + '\n',
    );
  }
  fs.writeFileSync(path.join(workBrain, 'skills.md'), indexLines.join(''), 'utf8');

  console.log(`[utlra][agent-pool] mem9 seed: ${skills.length} 条技能 → ${path.basename(workDir)}`);
}

/**
 * 将 workDir/.brain/skills 中的技能写入 mem9 shared:skills（fire-and-forget）。
 * 当 SkillMemoryStore 可用时，在本地 merge 之外额外调用此函数。
 */
export function mergeWorkDirSkillsToMem9(
  skillStore: SkillMemoryStore,
  workDir: string,
  sourceAgentId?: string,
): void {
  const workBrain     = path.join(workDir, '.brain');
  const workIndexPath = path.join(workBrain, 'skills.md');
  const workSkillsDir = path.join(workBrain, 'skills');

  if (!fs.existsSync(workIndexPath)) return;

  const workEntries = parseSkillIndex(fs.readFileSync(workIndexPath, 'utf8'));
  if (workEntries.length === 0) return;

  let queued = 0;
  for (const e of workEntries) {
    const contentPath = path.join(workSkillsDir, e.category, `${e.id}.md`);
    if (!fs.existsSync(contentPath)) continue;
    const content = fs.readFileSync(contentPath, 'utf8').trim();
    const record: SkillRecord = {
      id:            e.id,
      category:      e.category,
      title:         e.title,
      tags:          e.tags,
      content,
      ts:            e.ts || new Date().toISOString(),
      sourceAgentId: sourceAgentId ?? 'unknown',
    };
    skillStore.storeShared(record);
    queued++;
  }

  console.log(
    `[utlra][agent-pool] mem9 merge: ${queued} 条技能 → shared:skills from ${path.basename(workDir)}`,
  );
}

// ── drive9 扩展 ──────────────────────────────────────────────────────────────

/**
 * 从 drive9 shared 池语义检索技能，写入 workDir/.brain/skills（local seed）。
 * 原文存取，无 LLM 改写，drive9 内置 vector+BM25 混合搜索。
 */
export async function seedRelevantSkillsFromDrive9(
  skillStore: SkillDrive9Store,
  workDir: string,
  goal: string,
  topK = 5,
): Promise<void> {
  const skills = await skillStore.searchShared(goal, topK);
  if (skills.length === 0) {
    console.log(`[utlra][agent-pool] drive9 无相关技能，跳过 seed（${path.basename(workDir)}）`);
    return;
  }

  const workBrain     = path.join(workDir, '.brain');
  const workSkillsDir = path.join(workBrain, 'skills');
  fs.mkdirSync(workBrain, { recursive: true });

  const indexLines = [SKILLS_INDEX_HEADER];
  for (const skill of skills) {
    const destCat = path.join(workSkillsDir, skill.category);
    fs.mkdirSync(destCat, { recursive: true });
    // 写本地文件（内脑工具读本地文件，无需感知 drive9）
    fs.writeFileSync(
      path.join(destCat, `${skill.id}.md`),
      `# ${skill.title}\n\n> category: ${skill.category} | id: ${skill.id} | ${skill.ts}\n\n${skill.content}\n`,
      'utf8',
    );
    indexLines.push(
      [skill.id, skill.category, skill.title, skill.tags.join(','), skill.ts].join('\t') + '\n',
    );
  }
  fs.writeFileSync(path.join(workBrain, 'skills.md'), indexLines.join(''), 'utf8');
  console.log(`[utlra][agent-pool] drive9 seed: ${skills.length} 条技能 → ${path.basename(workDir)}`);
}

/**
 * drive9 seed 之后，从本地 agent-pool 补充尚未注入的技能（并集，不覆盖 drive9 已有 id）。
 */
export function seedLocalAgentPoolSkillsIntoWorkDir(
  dataRoot: string,
  workDir: string,
  goal: string,
  topK = 5,
): void {
  const poolBrain = getAgentPoolBrainDir(dataRoot);
  const selected = selectRelevantSkills(poolBrain, goal, topK);
  if (selected.length === 0) return;

  const workBrain = path.join(workDir, '.brain');
  const workSkillsDir = path.join(workBrain, 'skills');
  const workIndexPath = path.join(workBrain, 'skills.md');
  fs.mkdirSync(workBrain, { recursive: true });

  const existing = fs.existsSync(workIndexPath)
    ? parseSkillIndex(fs.readFileSync(workIndexPath, 'utf8'))
    : [];
  const existingIds = new Set(existing.map((e) => e.id));

  const poolSkillsDir = path.join(poolBrain, 'skills');
  let added = 0;
  const indexLines = fs.existsSync(workIndexPath)
    ? fs.readFileSync(workIndexPath, 'utf8').split('\n')
    : [SKILLS_INDEX_HEADER.trimEnd()];

  for (const e of selected) {
    if (existingIds.has(e.id)) continue;
    const src = path.join(poolSkillsDir, e.category, `${e.id}.md`);
    if (!fs.existsSync(src)) continue;
    const destCat = path.join(workSkillsDir, e.category);
    fs.mkdirSync(destCat, { recursive: true });
    fs.copyFileSync(src, path.join(destCat, `${e.id}.md`));
    indexLines.push([e.id, e.category, e.title, e.tags.join(','), e.ts].join('\t'));
    existingIds.add(e.id);
    added++;
  }

  if (added === 0) return;
  fs.writeFileSync(workIndexPath, indexLines.filter(Boolean).join('\n') + '\n', 'utf8');
  console.log(`[utlra][agent-pool] local pool 补充 ${added} 条技能 → ${path.basename(workDir)}`);
}

/**
 * set_goal 统一 seed：drive9 技能 + 本地池补充 + drive9 事实（方案 B）。
 */
export async function seedInnerBrainSharedContext(opts: {
  dataRoot: string;
  workDir: string;
  goal: string;
  skillDrive9Store?: SkillDrive9Store;
  knowledgeDrive9Store?: KnowledgeDrive9Store;
  skillStore?: SkillMemoryStore;
  skillTopK?: number;
  knowledgeTopK?: number;
}): Promise<void> {
  const skillTopK = opts.skillTopK ?? 5;
  const knowledgeTopK = opts.knowledgeTopK ?? 8;

  if (opts.skillDrive9Store) {
    await seedRelevantSkillsFromDrive9(opts.skillDrive9Store, opts.workDir, opts.goal, skillTopK);
    seedLocalAgentPoolSkillsIntoWorkDir(opts.dataRoot, opts.workDir, opts.goal, skillTopK);
  } else if (opts.skillStore) {
    await seedRelevantSkillsFromMem9(opts.skillStore, opts.workDir, opts.goal, skillTopK);
  } else {
    seedRelevantSkillsToWorkDir(opts.dataRoot, opts.workDir, opts.goal, skillTopK);
  }

  if (opts.knowledgeDrive9Store) {
    await seedRelevantKnowledgeToWorkDir(
      opts.knowledgeDrive9Store,
      opts.workDir,
      opts.goal,
      knowledgeTopK,
    );
  }
}

export { mergeWorkDirKnowledgeToDrive9, seedRelevantKnowledgeToWorkDir };

/**
 * 将 workDir/.brain/skills 中的技能写入 drive9 shared 池（fire-and-forget）。
 * drive9 原样存储，可精确还原。
 */
export function mergeWorkDirSkillsToDrive9(
  skillStore: SkillDrive9Store,
  workDir: string,
  sourceAgentId?: string,
): void {
  const workBrain     = path.join(workDir, '.brain');
  const workIndexPath = path.join(workBrain, 'skills.md');
  const workSkillsDir = path.join(workBrain, 'skills');

  if (!fs.existsSync(workIndexPath)) return;

  const workEntries = parseSkillIndex(fs.readFileSync(workIndexPath, 'utf8'));
  if (workEntries.length === 0) return;

  let queued = 0;
  for (const e of workEntries) {
    const contentPath = path.join(workSkillsDir, e.category, `${e.id}.md`);
    if (!fs.existsSync(contentPath)) continue;
    const rawContent = fs.readFileSync(contentPath, 'utf8').trim();

    skillStore.storeShared({
      id:            e.id,
      category:      e.category,
      title:         e.title,
      tags:          e.tags,
      content:       rawContent,
      ts:            e.ts || new Date().toISOString(),
      sourceAgentId: sourceAgentId ?? 'unknown',
    });
    queued++;
  }

  console.log(
    `[utlra][agent-pool] drive9 merge: ${queued} 条技能 → /skills/shared/ from ${path.basename(workDir)}`,
  );
}
