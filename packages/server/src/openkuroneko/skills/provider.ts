/**
 * 技能查询接口：内脑「查询可用技能」以接口形态提供，便于未来外挂不同技能库（外脑池、远程 API 等）。
 * 协议：doc/protocols/agent-pool.md
 */

import fs from 'node:fs';
import path from 'node:path';

import type { SkillEntry } from '../brain/brain-fs.js';

/** 查询可用技能的接口（当前实现查外脑技能库，未来可接其它库） */
export interface SkillProvider {
  /** 按 query 检索最相关的 topK 条技能条目（可异步，支持远端语义搜索） */
  search(query: string, topK?: number): Promise<SkillEntry[]> | SkillEntry[];
  /** 获取单条技能的完整内容 */
  getContent(entry: SkillEntry): string;
}

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

function parseSkillIndex(raw: string): SkillEntry[] {
  if (!raw.trim()) return [];
  return raw.split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('//'))
    .map(l => {
      const [id, category, title, tagsStr, ts] = l.split('\t');
      if (!id || !category || !title) return null;
      return {
        id: id.trim(),
        category: category.trim(),
        title: title.trim(),
        tags: (tagsStr ?? '').split(',').map(t => t.trim()).filter(Boolean),
        ts: (ts ?? '').trim(),
      } as SkillEntry;
    })
    .filter((e): e is SkillEntry => e !== null);
}

/**
 * 基于外脑技能池路径创建 SkillProvider。
 * poolPath 为空或目录不存在时，search 返回 []，getContent 返回 ''。
 */
export function createObSkillProvider(poolPath: string | undefined): SkillProvider {
  const skillsDir = poolPath ? path.join(poolPath, 'skills') : '';
  const indexPath = poolPath ? path.join(poolPath, 'skills.md') : '';

  return {
    search(query: string, topK = 5): SkillEntry[] {
      if (!poolPath || !fs.existsSync(indexPath)) return [];
      const raw = fs.readFileSync(indexPath, 'utf8');
      const entries = parseSkillIndex(raw);
      if (entries.length === 0) return [];

      const queryWords = tokenize(query);
      if (queryWords.size === 0) return entries.slice(0, topK);

      const scored = entries.map(entry => {
        const entryWords = new Set([
          ...tokenize(entry.title),
          ...entry.tags.flatMap(t => tokenize(t)),
          ...tokenize(entry.category),
        ]);
        let score = 0;
        for (const w of queryWords) {
          if (entryWords.has(w)) score++;
        }
        return { entry, score };
      });

      return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(s => s.entry);
    },

    getContent(entry: SkillEntry): string {
      if (!skillsDir) return '';
      const fp = path.join(skillsDir, entry.category, `${entry.id}.md`);
      if (!fs.existsSync(fp)) return '';
      return fs.readFileSync(fp, 'utf8').trim();
    },
  };
}
