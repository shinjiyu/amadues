import fs from 'node:fs';
import path from 'node:path';
import { isPathAllowed, pathSecurityError, getWorkDir } from './workdir-guard.js';
import type { Tool } from '../index.js';

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a file from the working directory or agent temp directory. Returns its text content.',
  parameters: {
    path: { type: 'string', description: 'File path to read' },
  },
  required: ['path'],
  async call(args): Promise<{ ok: boolean; output: string }> {
    const filePath = String(args['path'] ?? '').trim();
    if (!filePath) return { ok: false, output: 'Missing required argument: path' };
    const abs = path.isAbsolute(filePath) ? filePath : path.join(getWorkDir(), filePath);
    if (!isPathAllowed(abs)) return { ok: false, output: pathSecurityError(abs) };
    try {
      return { ok: true, output: fs.readFileSync(abs, 'utf8') };
    } catch (e) {
      return { ok: false, output: String(e) };
    }
  },
};
