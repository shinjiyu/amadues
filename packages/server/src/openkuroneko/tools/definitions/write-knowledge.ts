/**
 * write_knowledge — Attributor 专用工具
 * 向 .brain/knowledge.md 追加一条环境事实。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getWorkDir } from './workdir-guard.js';
import type { Tool } from '../index.js';

export const writeKnowledgeTool: Tool = {
  name: 'write_knowledge',
  description:
    '向 .brain/knowledge.md 追加一条关于当前环境或项目的客观事实。' +
    '仅在归因阶段调用，当发现新的可靠环境事实时调用。\n' +
    '格式：\n' +
    '  "[事实] <内容>"',
  parameters: {
    content: {
      type: 'string',
      description: '事实描述，以 [事实] 开头',
    },
  },
  required: ['content'],
  async call(args) {
    const content = String(args['content'] ?? '').trim();
    if (!content) return { ok: false, output: '缺少必需参数: content' };

    const brainDir = path.join(getWorkDir(), '.brain');
    const filePath = path.join(brainDir, 'knowledge.md');
    try {
      fs.mkdirSync(brainDir, { recursive: true });
      const ts = new Date().toISOString();
      const entry = `\n<!-- ${ts} -->\n${content}\n`;
      fs.appendFileSync(filePath, entry, 'utf8');
      return { ok: true, output: `知识已记录到 .brain/knowledge.md` };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  },
};
