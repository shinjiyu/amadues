import fs from 'node:fs';
import path from 'node:path';
import { isPathAllowed, pathSecurityError, getWorkDir } from './workdir-guard.js';
import type { Tool } from '../index.js';
import { prepareSelfUpdateMutation } from '../../../self-update/session.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write text content to a file in the working directory (overwrites).',
  parameters: {
    path:    { type: 'string', description: 'File path relative to workDir (e.g. "src/snake.js")' },
    content: { type: 'string', description: 'Full text content to write into the file' },
  },
  required: ['path', 'content'],
  async call(args): Promise<{ ok: boolean; output: string }> {
    const filePath = String(args['path'] ?? '').trim();
    const content  = String(args['content'] ?? '');
    if (!filePath) return { ok: false, output: 'Missing required argument: path' };
    const abs = path.isAbsolute(filePath) ? filePath : path.join(getWorkDir(), filePath);
    if (!isPathAllowed(abs)) return { ok: false, output: pathSecurityError(abs) };
    try {
      const prep = prepareSelfUpdateMutation(getWorkDir(), abs);
      if (!prep.ok) return { ok: false, output: prep.reason };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      return { ok: true, output: `Written ${content.length} chars to ${abs}` };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  },
};
