/**
 * Node Skill Tools — Attributor 阶段 record_skill。
 *
 * ADL：doc/structurizr/INNER-NODE-SKILLS.md §4
 */

import type { Tool } from '../tools/index.js';
import type { LocalNodeStore } from './local-node-store.js';
import type { NodeSkillStore } from './node-skill-store.js';

export function createRecordSkillTool(
  skillStore: NodeSkillStore,
  localStore: LocalNodeStore,
): Tool {
  return {
    name: 'record_skill',
    description:
      '把一段可复用的操作步骤写入节点绑定技能库（须指定 nodeRef）。用于固化 Playwright 序列、脚本模式、API 调用链等战术步骤。',
    parameters: {
      nodeRef: { type: 'string', description: 'LocalNode id（如 preset/base 或 local/ps_open）' },
      category: { type: 'string', description: '技能分类，如 browser / shell / api / general' },
      title: { type: 'string', description: '一句话标题' },
      tags: { type: 'string', description: '可选：逗号分隔标签' },
      content: { type: 'string', description: '完整操作步骤（Markdown）' },
    },
    required: ['nodeRef', 'category', 'title', 'content'],
    async call(args) {
      const nodeRef = String(args['nodeRef'] ?? '').trim();
      if (!nodeRef) return { ok: false, output: 'record_skill: nodeRef 必填' };
      const category = String(args['category'] ?? '').trim() || 'general';
      const title = String(args['title'] ?? '').trim();
      const content = String(args['content'] ?? '').trim();
      if (!title || !content) {
        return { ok: false, output: 'record_skill: title 与 content 必填' };
      }
      const tagsRaw = String(args['tags'] ?? '').trim();
      const tags = tagsRaw ? tagsRaw.split(/[,;]/).map(t => t.trim()).filter(Boolean) : undefined;

      try {
        const result = skillStore.writeSkill(nodeRef, { category, title, content, tags });
        skillStore.attachToLocalNode(localStore, nodeRef, result.ref);
        return {
          ok: true,
          output: `recorded skill ${result.id} (${result.action}) on ${nodeRef}`,
        };
      } catch (e) {
        return { ok: false, output: `record_skill 失败：${String(e)}` };
      }
    },
  };
}
