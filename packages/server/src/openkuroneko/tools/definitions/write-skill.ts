/**
 * write_skill — Attributor 专用工具
 *
 * 将可复用的操作模式写入技能库：
 *   .brain/skills/<category>/<id>.md  ← 完整技能内容
 *   .brain/skills.md                  ← 目录索引（TSV）
 *
 * 技能库按二级目录分类，Executor 执行时动态检索相关技能。
 */

import { getWorkDir } from './workdir-guard.js';
import { BrainFS } from '../../brain/index.js';
import { getSkillMemoryStore } from '../../../mem9/skill-memory-store.js';
import { getSkillDrive9Store } from '../../../drive9/skill-drive9-store.js';
import type { Tool } from '../index.js';

/** 预定义技能分类（引导 LLM 选择，也可自定义） */
const CATEGORIES = [
  'browser',   // Playwright / 浏览器自动化
  'web',       // HTTP 搜索 / 数据抓取
  'file',      // 文件读写 / 目录扫描
  'shell',     // shell 命令 / 脚本执行
  'code',      // 代码编写 / 调试
  'data',      // 数据分析 / 格式转换
  'agent',     // 子 Agent 调用 / 协调
  'general',   // 通用流程
];

export const writeSkillTool: Tool = {
  name: 'write_skill',
  description:
    '将一条可复用的成功操作模式（技能）写入技能库。仅在归因阶段调用。\n\n' +
    '技能库按二级目录存储，Executor 执行时会自动检索相关技能注入上下文。\n\n' +
    '分类（category）选项：' + CATEGORIES.join(' | ') + '\n\n' +
    '内容格式（content）：\n' +
    '  场景：<具体遇到什么情况，越具体越好>\n' +
    '  步骤：\n' +
    '    1. <操作1>\n' +
    '    2. <操作2>\n' +
    '  验证：<如何确认成功>',
  parameters: {
    category: {
      type: 'string',
      description: `技能分类，选择最匹配的一个：${CATEGORIES.join(', ')}`,
    },
    title: {
      type: 'string',
      description: '技能标题（一句话，10-30字，用于索引检索）',
    },
    tags: {
      type: 'string',
      description: '关键词标签，逗号分隔（用于动态检索匹配），例如：playwright,登录,微博,cookies',
    },
    content: {
      type: 'string',
      description: '技能完整描述，包含「场景 / 步骤 / 验证」三段',
    },
  },
  required: ['category', 'title', 'tags', 'content'],
  async call(args) {
    const category = String(args['category'] ?? 'general').trim();
    const title    = String(args['title']    ?? '').trim();
    const tagsRaw  = String(args['tags']     ?? '').trim();
    const content  = String(args['content']  ?? '').trim();

    if (!title)   return { ok: false, output: '缺少必需参数: title' };
    if (!content) return { ok: false, output: '缺少必需参数: content' };

    const tags = tagsRaw.split(/[,，]+/).map(t => t.trim()).filter(Boolean);
    const workDir = getWorkDir();
    const brain = new BrainFS(workDir);

    try {
      const { id, action } = brain.writeSkill({ category, title, tags, content });

      const ts            = new Date().toISOString();
      const sourceAgentId = process.env['INNER_WORKSPACE_ID'] ?? 'unknown';

      // drive9 优先（原文存储）
      const drive9Store = getSkillDrive9Store();
      if (drive9Store) {
        drive9Store.storeShared({ id, category, title, tags, content, ts, sourceAgentId });
      } else {
        // mem9 降级（有 LLM 改写，但 rawContent 保留原文）
        const skillStore = getSkillMemoryStore();
        skillStore?.storeShared({ id, category, title, tags, content, ts, sourceAgentId });
      }

      const msg = action === 'merged'
        ? `已合并到相似技能 ${id}（.brain/skills/${category}/${id}.md），避免重复`
        : `新技能已创建：.brain/skills/${category}/${id}.md（索引已更新）`;
      return { ok: true, output: msg };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  },
};
