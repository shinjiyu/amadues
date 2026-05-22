/**
 * SkillMemoryStore — 基于 mem9 的技能语义存储层
 *
 * 命名空间：
 *   shared:skills   — 全局共享技能池（所有 agent 可读写，用于跨 session 语义检索）
 *   ${sid}:skills   — 个人技能库（单个 agent 私有，保留供未来使用）
 *
 * 职责：
 *   - 内脑完成后：将本地 .brain/skills 写入 shared:skills（异步 fire-and-forget）
 *   - 内脑启动前：从 shared:skills 语义检索相关技能，写入 workDir/.brain/skills（local seed）
 *   - Attributor write_skill：写本地的同时也写 shared:skills
 *
 * 注意：mem9 store 是全异步的，LLM 会对内容做提炼/去重。
 * metadata 字段（skillId、category、title、tags）会原样保留，用于还原 SkillEntry。
 */

import { Mem9Client, type Memory } from './mem9-client.js';

export const SHARED_SKILLS_AGENT_ID = 'shared:skills';

/** 技能记录（与本地 SkillEntry 对齐，额外含 content） */
export interface SkillRecord {
  id: string;
  category: string;
  title: string;
  tags: string[];
  content: string;
  ts: string;
  sourceAgentId?: string;
}

export class SkillMemoryStore {
  constructor(private readonly mem9: Mem9Client) {}

  /**
   * 将技能写入 shared:skills（fire-and-forget）。
   * 由 mergeWorkDirSkillsToAgentPool 和 write_skill 调用。
   */
  storeShared(skill: SkillRecord): void {
    const content = formatSkill(skill);
    void this.mem9
      .store({
        content,
        agentId: SHARED_SKILLS_AGENT_ID,
        metadata: {
          type: 'skill',
          skillId: skill.id,
          category: skill.category,
          title: skill.title,
          tags: skill.tags,
          ts: skill.ts,
          sourceAgentId: skill.sourceAgentId ?? 'unknown',
          // mem9 LLM 会改写 content，rawContent 保留原始技能步骤，取回时优先使用
          rawContent: skill.content,
        },
      })
      .catch((e: unknown) =>
        console.warn('[skill-store] storeShared failed:', (e as Error).message),
      );
  }

  /**
   * 从 shared:skills 语义搜索技能。
   * 由 seedRelevantSkillsFromMem9 调用，返回重建的 SkillRecord[]。
   */
  async searchShared(query: string, limit = 8): Promise<SkillRecord[]> {
    try {
      const mems = await this.mem9.search({
        query,
        agentId: SHARED_SKILLS_AGENT_ID,
        limit,
      });
      return mems.map(parseSkillMemory).filter((s): s is SkillRecord => s !== null);
    } catch (e) {
      console.warn('[skill-store] searchShared failed:', (e as Error).message);
      return [];
    }
  }

  /**
   * 列出 shared:skills 中所有技能（无查询，按写入顺序）。
   */
  async listShared(limit = 50): Promise<SkillRecord[]> {
    try {
      const mems = await this.mem9.search({
        agentId: SHARED_SKILLS_AGENT_ID,
        limit,
      });
      return mems.map(parseSkillMemory).filter((s): s is SkillRecord => s !== null);
    } catch (e) {
      console.warn('[skill-store] listShared failed:', (e as Error).message);
      return [];
    }
  }
}

// ── 格式化 / 解析 ────────────────────────────────────────────────────────────

/**
 * 将 SkillRecord 序列化为 mem9 存储内容。
 * 头部结构化字段 + 空行 + 原始技能内容，方便 LLM 理解和搜索。
 */
export function formatSkill(skill: SkillRecord): string {
  return [
    `# [skill] ${skill.title}`,
    `分类: ${skill.category}`,
    `标签: ${skill.tags.join(', ')}`,
    `ID: ${skill.id}`,
    '',
    skill.content,
  ].join('\n');
}

/**
 * 从 mem9 Memory 还原 SkillRecord。
 * 优先从 metadata 读取结构化字段（避免受 LLM 重写影响）。
 */
function parseSkillMemory(m: Memory): SkillRecord | null {
  const meta = m.metadata ?? {};
  const id       = (meta['skillId']  as string | undefined) || m.id;
  const category = (meta['category'] as string | undefined) || 'general';
  const title    = (meta['title']    as string | undefined) || '';
  const tags     = (meta['tags']     as string[] | undefined) || [];
  const ts       = (meta['ts']       as string | undefined)
    || m.created_at
    || new Date().toISOString();
  const sourceAgentId = (meta['sourceAgentId'] as string | undefined);

  // mem9 LLM 会把 content 碎片化成事实句，优先从 metadata.rawContent 恢复原始步骤
  const rawContent = meta['rawContent'] as string | undefined;
  let content: string;
  if (rawContent) {
    content = rawContent.trim();
  } else {
    // 兜底：从存储内容中剥离头部行（对旧数据的降级处理）
    const lines = m.content.split('\n');
    const emptyLineIdx = lines.findIndex((l) => l.trim() === '');
    content = emptyLineIdx >= 0
      ? lines.slice(emptyLineIdx + 1).join('\n').trim()
      : m.content.trim();
  }

  if (!title && !content) return null;

  return {
    id,
    category,
    title: title || content.slice(0, 40),
    tags,
    content,
    ts,
    sourceAgentId,
  };
}

// ── 工厂 ─────────────────────────────────────────────────────────────────────

/** 模块级单例，供 write-skill.ts 等工具在无法 prop-drill 时使用 */
let _instance: SkillMemoryStore | null | undefined;

/**
 * 懒加载全局单例。
 * 读取 MEM9_API_KEY 环境变量；未配置时返回 null。
 * 适用于在内脑 worker 进程中调用（继承父进程的 env）。
 */
export function getSkillMemoryStore(): SkillMemoryStore | null {
  if (_instance !== undefined) return _instance;
  const apiKey = process.env['MEM9_API_KEY'];
  if (!apiKey) {
    _instance = null;
    return null;
  }
  _instance = new SkillMemoryStore(new Mem9Client({ apiKey }));
  return _instance;
}

/**
 * 用已有 Mem9Client 实例初始化单例（由 index.ts 在启动时调用）。
 * 调用后 getSkillMemoryStore() 将返回此实例。
 */
export function initSkillMemoryStore(mem9: Mem9Client): SkillMemoryStore {
  _instance = new SkillMemoryStore(mem9);
  return _instance;
}
