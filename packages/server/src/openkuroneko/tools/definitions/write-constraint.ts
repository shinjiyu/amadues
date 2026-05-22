/**
 * write_constraint — Attributor 专用工具
 * 向 .brain/constraints.md 追加一条约束（红线或避坑）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getWorkDir } from './workdir-guard.js';
import type { Tool } from '../index.js';

export const writeConstraintTool: Tool = {
  name: 'write_constraint',
  description:
    '向 .brain/constraints.md 追加一条约束记录（红线或避坑指南）。' +
    '仅在归因阶段调用。\n' +
    '格式：\n' +
    '  "[红线] <禁止行为> — <原因>"\n' +
    '  "[避坑] <注意事项> — <适用场景>"',
  parameters: {
    content: {
      type: 'string',
      description: '约束内容，以 [红线] 或 [避坑] 开头',
    },
  },
  required: ['content'],
  async call(args) {
    const content = String(args['content'] ?? '').trim();
    if (!content) return { ok: false, output: '缺少必需参数: content' };

    const brainDir = path.join(getWorkDir(), '.brain');
    const filePath = path.join(brainDir, 'constraints.md');
    try {
      fs.mkdirSync(brainDir, { recursive: true });
      const ts = new Date().toISOString();
      const entry = `\n<!-- ${ts} -->\n${content}\n`;
      fs.appendFileSync(filePath, entry, 'utf8');
      return { ok: true, output: `约束已记录到 .brain/constraints.md` };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  },
};
