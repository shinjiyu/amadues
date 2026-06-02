import fs from 'node:fs';
import path from 'node:path';
import { isPathWritable, pathSecurityError, getWorkDir } from './workdir-guard.js';
import type { Tool } from '../index.js';
import { prepareSelfUpdateMutation } from '../../../self-update/session.js';

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace a specific string in a file with a new string (first occurrence). ' +
    'Prefer small old_string/new_string patches over rewriting whole files with write_file.',
  parameters: {
    path:       { type: 'string', description: 'File path to edit' },
    old_string: { type: 'string', description: 'Exact string to find and replace' },
    new_string: { type: 'string', description: 'String to replace it with' },
  },
  required: ['path', 'old_string', 'new_string'],
  async call(args): Promise<{ ok: boolean; output: string }> {
    const filePath = String(args['path'] ?? '').trim();
    const oldStr   = String(args['old_string'] ?? '');
    const newStr   = String(args['new_string'] ?? '');
    if (!filePath || !oldStr) {
      return { ok: false, output: 'Missing required arguments: path, old_string' };
    }
    const abs = path.isAbsolute(filePath) ? filePath : path.join(getWorkDir(), filePath);
    if (!isPathWritable(abs)) return { ok: false, output: pathSecurityError(abs) };
    try {
      const prep = prepareSelfUpdateMutation(getWorkDir(), abs);
      if (!prep.ok) return { ok: false, output: prep.reason };
      const content = fs.readFileSync(abs, 'utf8');
      if (!content.includes(oldStr)) {
        return { ok: false, output: `old_string not found in ${abs}` };
      }
      fs.writeFileSync(abs, content.replace(oldStr, newStr), 'utf8');
      return { ok: true, output: `Replaced in ${abs}` };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  },
};
