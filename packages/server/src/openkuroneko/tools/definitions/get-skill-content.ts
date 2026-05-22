/**
 * get_skill_content — 按 id 获取单条技能的完整内容（渐进式披露：按需加载）
 *
 * Executor 首轮仅注入技能索引；当 LLM 需要某条技能的详细步骤时，调用本工具获取全文。
 * 设计见：doc/designs/skills-progressive-disclosure.md
 */

import path from 'node:path';
import fs from 'node:fs';

import { getWorkDir } from './workdir-guard.js';
import { BrainFS } from '../../brain/index.js';
import type { Tool } from '../index.js';

export const getSkillContentTool: Tool = {
  name: 'get_skill_content',
  description:
    '根据技能 id 获取该技能的完整内容（场景、步骤、验证等）。当「技能库」中仅列出索引时，若需要某条技能的具体操作步骤，请调用本工具并传入对应的 skill_id。',
  parameters: {
    skill_id: {
      type: 'string',
      description: '技能 id（从技能库索引中获取，如 read_file-6cb8、skill-9370）',
    },
  },
  required: ['skill_id'],
  async call(args) {
    const skillId = String(args['skill_id'] ?? '').trim();
    if (!skillId) return { ok: false, output: '缺少参数: skill_id' };

    const workDir = getWorkDir();
    const brain = new BrainFS(workDir);
    const index = brain.readSkillIndex();
    const entry = index.find((e) => e.id === skillId);
    if (!entry) {
      return {
        ok: true,
        output: `未找到 id 为「${skillId}」的技能。请确认技能库索引中的 id 拼写正确。`,
      };
    }

    const fp = path.join(workDir, '.brain', 'skills', entry.category, `${entry.id}.md`);
    if (!fs.existsSync(fp)) {
      return { ok: true, output: `技能文件不存在：.brain/skills/${entry.category}/${entry.id}.md` };
    }

    const content = fs.readFileSync(fp, 'utf8').trim();
    return { ok: true, output: content };
  },
};
