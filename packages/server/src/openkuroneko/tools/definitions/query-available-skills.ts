/**
 * query_available_skills — 查询可用技能（接口形态，当前实现查外脑技能库）
 *
 * 当 LLM 认为当前工具不足以解决问题时，应先发起一轮查询，再根据返回的技能内容决策。
 * 未来可外挂不同技能库，工具通过 SkillProvider 接口调用。
 */

import type { Tool } from '../index.js';
import type { SkillProvider } from '../../skills/provider.js';

const DEFAULT_TOP_K = 5;
const CONTENT_MAX = 4000;

/**
 * 创建「查询可用技能」工具，依赖注入 SkillProvider（如外脑池实现）。
 */
export function createQueryAvailableSkillsTool(provider: SkillProvider): Tool {
  return {
    name: 'query_available_skills',
    description:
      '从外部技能库查询与当前需求相关的可用技能。当现有工具不足以完成任务时，应先调用本工具获取可复用操作模式，再决定如何执行。\n\n' +
      'query：描述你当前需要的能力或场景（如「读文件」「浏览器自动化」「运行脚本」）。\n' +
      'top_k：返回最多几条技能（默认 5）。',
    parameters: {
      query: {
        type: 'string',
        description: '当前需求或场景描述，用于匹配技能标题与标签',
      },
      top_k: {
        type: 'number',
        description: '返回技能条数上限，默认 5',
      },
    },
    required: ['query'],
    async call(args) {
      const query = String(args['query'] ?? '').trim();
      const topK = Math.min(20, Math.max(1, Number(args['top_k']) || DEFAULT_TOP_K));

      if (!query) return { ok: false, output: '缺少参数: query' };

      const entries = await Promise.resolve(provider.search(query, topK));
      if (entries.length === 0) {
        return {
          ok: true,
          output: '未配置外部技能库或未找到相关技能。若由外脑启动，请确认外脑技能池已存在且包含技能。',
        };
      }

      const parts: string[] = [`找到 ${entries.length} 条相关技能：\n`];
      for (const e of entries) {
        const content = provider.getContent(e);
        const truncated = content.length > CONTENT_MAX
          ? content.slice(0, CONTENT_MAX) + '\n…（内容已截断）'
          : content;
        parts.push(`## ${e.title} (id: ${e.id}, category: ${e.category})\n${truncated}\n`);
      }
      return { ok: true, output: parts.join('\n---\n\n') };
    },
  };
}
