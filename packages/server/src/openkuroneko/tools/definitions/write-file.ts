import fs from 'node:fs';
import path from 'node:path';
import { getWorkDir, isPathWritable, pathSecurityError } from './workdir-guard.js';
import type { Tool } from '../index.js';
import { prepareSelfUpdateMutation } from '../../../self-update/session.js';
import { isRejectedWriteContent, REJECTED_WRITE_CONTENT_MSG } from '../write-content-guard.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write text content to a file in the working directory.\n' +
    'mode=overwrite（默认）整文件覆盖；mode=append 在文件末尾追加（文件不存在则创建）。\n' +
    '大段代码写入后旧轮对话历史会替换为 __SLIM_REF__（文件已在 workDir）；同路径禁止二次 overwrite，请用 edit_file 或 append。',
  parameters: {
    path:    { type: 'string', description: 'File path relative to workDir (e.g. "src/snake.js")' },
    content: { type: 'string', description: 'Text content to write or append' },
    mode: {
      type: 'string',
      description: 'overwrite | append（默认 overwrite）',
      enum: ['overwrite', 'append'],
    },
  },
  required: ['path', 'content'],
  async call(args): Promise<{ ok: boolean; output: string }> {
    const filePath = String(args['path'] ?? '').trim();
    const content  = String(args['content'] ?? '');
    const modeRaw  = String(args['mode'] ?? 'overwrite').trim().toLowerCase();
    const mode     = modeRaw === 'append' ? 'append' : 'overwrite';
    if (!filePath) return { ok: false, output: 'Missing required argument: path' };
    if (isRejectedWriteContent(content)) {
      return { ok: false, output: REJECTED_WRITE_CONTENT_MSG };
    }
    const abs = path.isAbsolute(filePath) ? filePath : path.join(getWorkDir(), filePath);
    if (!isPathWritable(abs)) return { ok: false, output: pathSecurityError(abs) };
    try {
      const prep = prepareSelfUpdateMutation(getWorkDir(), abs);
      if (!prep.ok) return { ok: false, output: prep.reason };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (mode === 'append') {
        fs.appendFileSync(abs, content, 'utf8');
        return { ok: true, output: `Appended ${content.length} chars to ${abs}` };
      }
      fs.writeFileSync(abs, content, 'utf8');
      return { ok: true, output: `Written ${content.length} chars to ${abs}` };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  },
};
