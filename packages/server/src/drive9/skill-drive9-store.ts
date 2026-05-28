/**
 * SkillDrive9Store — 基于 drive9 的技能存储层
 *
 * 目录结构（drive9 workspace 内）：
 *   /skills/shared/{id}.md     — 共享技能池（所有 agent 可读写）
 *   /skills/{agentSid}/{id}.md — 个人技能库（单 agent 私有）
 *   /knowledge/shared/{id}.md — 共享事实（见 knowledge-drive9-store.ts）
 *   /constraints/{agentSid}/{id}.md — 红线（未来扩展）
 *
 * 与 mem9 的分工：
 *   drive9 — 原文存取（skills / knowledge / constraints），不经 LLM 改写
 *   mem9   — 对话摘要（chat log / tasks），图谱化没关系
 *
 * 语义搜索：drive9 内置 vector + BM25 混合搜索（TiDB 后端，同 mem9），
 *   `grep(query, '/skills/shared/')` 返回匹配路径 → 读取原文。
 */

import type { Drive9Client } from './drive9-client.js';

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface SkillRecord {
  id:            string;
  category:      string;
  title:         string;
  tags:          string[];
  content:       string;   // 原始技能步骤，原样保留
  ts:            string;
  sourceAgentId?: string;
}

// ── 路径约定 ──────────────────────────────────────────────────────────────────

export const SHARED_SKILLS_DIR = '/skills/shared';

export function skillPath(id: string, agentSid?: string): string {
  const dir = agentSid ? `/skills/${agentSid}` : SHARED_SKILLS_DIR;
  return `${dir}/${id}.md`;
}

// ── 文件格式 ──────────────────────────────────────────────────────────────────

/**
 * 序列化 SkillRecord 为 Markdown 文件内容。
 * 头部结构化注释 + 空行 + 原始内容，drive9 不改写任何内容。
 */
export function serializeSkill(skill: SkillRecord): string {
  return [
    `# ${skill.title}`,
    ``,
    `<!-- meta`,
    `id: ${skill.id}`,
    `category: ${skill.category}`,
    `tags: ${skill.tags.join(', ')}`,
    `ts: ${skill.ts}`,
    `source: ${skill.sourceAgentId ?? 'unknown'}`,
    `-->`,
    ``,
    skill.content,
  ].join('\n');
}

/**
 * 从 Markdown 文件内容还原 SkillRecord。
 */
export function deserializeSkill(content: string, fallbackId: string): SkillRecord {
  const lines = content.split('\n');

  // 标题
  const title = lines[0]?.replace(/^#\s*/, '').trim() ?? '';

  // 解析 <!-- meta ... --> 块
  const metaStart = lines.findIndex((l) => l.trim() === '<!-- meta');
  const metaEnd   = lines.findIndex((l, i) => i > metaStart && l.trim() === '-->');

  let id       = fallbackId;
  let category = 'general';
  let tags: string[] = [];
  let ts       = new Date().toISOString();
  let source   = 'unknown';

  if (metaStart >= 0 && metaEnd > metaStart) {
    for (let i = metaStart + 1; i < metaEnd; i++) {
      const [key, ...rest] = (lines[i] ?? '').split(':');
      const val = rest.join(':').trim();
      switch (key?.trim()) {
        case 'id':       id       = val; break;
        case 'category': category = val; break;
        case 'tags':     tags     = val.split(',').map((t) => t.trim()).filter(Boolean); break;
        case 'ts':       ts       = val; break;
        case 'source':   source   = val; break;
      }
    }
  }

  // 技能内容：<!-- meta --> 块之后的部分
  const contentStart = metaEnd >= 0 ? metaEnd + 1 : 2;
  const skillContent = lines.slice(contentStart).join('\n').trim();

  return { id, category, title, tags, content: skillContent, ts, sourceAgentId: source };
}

// ── 主类 ─────────────────────────────────────────────────────────────────────

export class SkillDrive9Store {
  constructor(private readonly drive9: Drive9Client) {}

  /**
   * 将技能写入 shared 池（fire-and-forget）。
   * drive9 原样存储，不经 LLM 改写。
   */
  storeShared(skill: SkillRecord): void {
    const path    = skillPath(skill.id);
    const content = serializeSkill(skill);
    void this.drive9
      .write(path, content)
      .catch((e: unknown) =>
        console.warn('[drive9-skill] storeShared failed:', (e as Error).message),
      );
  }

  /**
   * 从 shared 池语义搜索相关技能。
   * 返回完整 SkillRecord[]（原文，不被 LLM 改写）。
   */
  async searchShared(query: string, limit = 8): Promise<SkillRecord[]> {
    try {
      const results = await this.drive9.grep(query, SHARED_SKILLS_DIR, limit);
      if (!results.length) return [];

      const skills = await Promise.all(
        results.map(async (r) => {
          try {
            const content = await this.drive9.read(r.path);
            const id      = r.name.replace(/\.md$/, '');
            return deserializeSkill(content, id);
          } catch {
            return null;
          }
        }),
      );
      return skills.filter((s): s is SkillRecord => s !== null);
    } catch (e) {
      console.warn('[drive9-skill] searchShared failed:', (e as Error).message);
      return [];
    }
  }

  /**
   * 列出 shared 池所有技能（用于全量加载 / 调试）。
   */
  async listShared(limit = 100): Promise<SkillRecord[]> {
    try {
      const entries = await this.drive9.list(SHARED_SKILLS_DIR);
      const mdFiles = entries.filter((e) => !e.isDir && e.name.endsWith('.md'));
      const slice   = mdFiles.slice(0, limit);

      const skills = await Promise.all(
        slice.map(async (e) => {
          try {
            const path    = `${SHARED_SKILLS_DIR}/${e.name}`;
            const content = await this.drive9.read(path);
            const id      = e.name.replace(/\.md$/, '');
            return deserializeSkill(content, id);
          } catch {
            return null;
          }
        }),
      );
      return skills.filter((s): s is SkillRecord => s !== null);
    } catch (e) {
      console.warn('[drive9-skill] listShared failed:', (e as Error).message);
      return [];
    }
  }

  /** 读取单条技能（按 id）。 */
  async getShared(id: string): Promise<SkillRecord | null> {
    try {
      const content = await this.drive9.read(skillPath(id));
      return deserializeSkill(content, id);
    } catch {
      return null;
    }
  }
}

// ── 模块级单例 ────────────────────────────────────────────────────────────────

import { getDrive9Client, initDrive9Client } from './drive9-client.js';

let _instance: SkillDrive9Store | null | undefined;

/**
 * 懒加载全局单例（读取 DRIVE9_API_KEY env）。
 */
export function getSkillDrive9Store(): SkillDrive9Store | null {
  if (_instance !== undefined) return _instance;
  const client = getDrive9Client();
  _instance = client ? new SkillDrive9Store(client) : null;
  return _instance;
}

/**
 * 用已有 Drive9Client 初始化单例（由 index.ts 在启动时调用）。
 */
export function initSkillDrive9Store(apiKey: string, apiUrl?: string): SkillDrive9Store {
  const client = initDrive9Client(apiKey, apiUrl);
  _instance    = new SkillDrive9Store(client);
  return _instance;
}
