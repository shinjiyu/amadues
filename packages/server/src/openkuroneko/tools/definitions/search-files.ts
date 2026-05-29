import { getWorkDir } from './workdir-guard.js';
import { searchFilesUnderRoot } from './file-search.js';
import type { Tool } from '../index.js';

function parseBool(raw: unknown): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function formatHits(hits: ReturnType<typeof searchFilesUnderRoot>): string {
  if (hits.length === 0) return '（无匹配）';
  return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n');
}

export const searchFilesTool: Tool = {
  name: 'search_files',
  description:
    'Search file contents under the current workDir (regex by default). ' +
    'Returns path:line:snippet. Prefer this over shell_exec + rg for reliability across platforms.',
  parameters: {
    query: {
      type: 'string',
      description: 'Search pattern (regex unless literal=true)',
    },
    path: {
      type: 'string',
      description: 'Subdirectory under workDir to search (default ".")',
    },
    glob: {
      type: 'string',
      description: 'Filename filter, e.g. "*.md", "*.ts", "report.txt"',
    },
    max_results: {
      type: 'string',
      description: 'Max hits to return (default 50, max 200)',
    },
    literal: {
      type: 'string',
      description: 'true = literal substring match, not regex',
    },
  },
  required: ['query'],
  async call(args): Promise<{ ok: boolean; output: string }> {
    const query = String(args['query'] ?? '').trim();
    if (!query) return { ok: false, output: 'Missing required argument: query' };
    const maxN = Math.min(Math.max(parseInt(String(args['max_results'] ?? '50'), 10) || 50, 1), 200);
    const hits = searchFilesUnderRoot({
      root: getWorkDir(),
      query,
      subdir: args['path'] != null ? String(args['path']) : '.',
      glob: args['glob'] != null ? String(args['glob']) : undefined,
      maxResults: maxN,
      literal: parseBool(args['literal']),
    });
    return { ok: true, output: formatHits(hits) };
  },
};
