/**
 * Drive9SkillProvider — 基于 drive9 的语义技能搜索实现
 *
 * 替代 createObSkillProvider 的纯关键词方案，改用 drive9 vector+BM25 混合搜索。
 * 搜索结果为原文（不经 LLM 改写），content 即可直接复用。
 *
 * 注入路径：run-tick.ts → createQueryAvailableSkillsTool(provider)
 * 降级：DRIVE9_API_KEY 未设置时仍用 createObSkillProvider（本地关键词）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SkillEntry } from '../brain/brain-fs.js';
import type { SkillProvider } from './provider.js';
import { Drive9Client } from '../../drive9/drive9-client.js';
import { SHARED_SKILLS_DIR, deserializeSkill } from '../../drive9/skill-drive9-store.js';

export class Drive9SkillProvider implements SkillProvider {
  private readonly client: Drive9Client;

  /** workDir 的本地 skills 路径，作为 getContent 的 fallback（seed 时已写入本地） */
  private readonly localSkillsDir: string | null;

  constructor(apiKey: string, apiUrl?: string, localSkillsDir?: string) {
    this.client         = new Drive9Client({ apiKey, apiUrl });
    this.localSkillsDir = localSkillsDir ?? null;
  }

  /**
   * 异步语义搜索 drive9 shared skills pool。
   * 返回 SkillEntry[]（title/category/tags/id 从文件头解析）。
   * getContent() 使用已有 entry.id 直接返回 content（搜索时已读取原文）。
   */
  private _cache: Map<string, string> = new Map(); // id → full content

  async search(query: string, topK = 5): Promise<SkillEntry[]> {
    this._cache.clear();
    try {
      const results = await this.client.grep(query, SHARED_SKILLS_DIR, topK);
      if (!results.length) return [];

      const entries = await Promise.all(
        results.map(async (r) => {
          try {
            const raw   = await this.client.read(r.path);
            const id    = r.name.replace(/\.md$/, '');
            const skill = deserializeSkill(raw, id);
            // 缓存原文，供 getContent() 同步返回
            this._cache.set(id, skill.content);
            return {
              id:       skill.id,
              category: skill.category,
              title:    skill.title,
              tags:     skill.tags,
              ts:       skill.ts,
            } as SkillEntry;
          } catch {
            return null;
          }
        }),
      );
      return entries.filter((e): e is SkillEntry => e !== null);
    } catch (e) {
      console.warn('[drive9-provider] search failed:', (e as Error).message);
      return [];
    }
  }

  /**
   * 同步返回技能内容。
   * search() 调用后 _cache 中已有原文；若缺失则尝试读本地 seed 文件。
   */
  getContent(entry: SkillEntry): string {
    // 优先读搜索时缓存的原文
    const cached = this._cache.get(entry.id);
    if (cached) return cached;

    // 降级：读本地 seed 文件（outer brain 启动时写入）
    if (this.localSkillsDir) {
      try {
        const fp = path.join(this.localSkillsDir, entry.category, `${entry.id}.md`);
        if (fs.existsSync(fp)) return fs.readFileSync(fp, 'utf8').trim();
      } catch { /* ignore */ }
    }
    return '';
  }
}
