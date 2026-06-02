import path from 'node:path';
import { isPathReadable, pathSecurityError, getWorkDir } from './workdir-guard.js';
import { readTextFilePaginated } from './read-file-lines.js';
import type { Tool } from '../index.js';

function parseOptionalInt(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a text file from the working directory (paginated). ' +
    'Default limit 200 lines; large files (>64KiB) require offset_line/limit_lines. ' +
    'Peer deliverable catalog: `.inbox/README.md`.',
  parameters: {
    path: { type: 'string', description: 'File path relative to workDir' },
    offset_line: { type: 'number', description: '1-based start line (default 1)' },
    limit_lines: { type: 'number', description: 'Max lines to return (default 200, max 500)' },
  },
  required: ['path'],
  async call(args): Promise<{ ok: boolean; output: string }> {
    const filePath = String(args['path'] ?? '').trim();
    if (!filePath) return { ok: false, output: 'Missing required argument: path' };
    const abs = path.isAbsolute(filePath) ? filePath : path.join(getWorkDir(), filePath);
    if (!isPathReadable(abs)) return { ok: false, output: pathSecurityError(abs) };
    return readTextFilePaginated(abs, {
      offsetLine: parseOptionalInt(args['offset_line']),
      limitLines: parseOptionalInt(args['limit_lines']),
    });
  },
};
