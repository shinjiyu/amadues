import path from 'node:path';
import {
  listPeerWorkspaces,
  resolvePeerReadPath,
} from './workdir-guard.js';
import { listFilesUnderRoot, searchFilesUnderRoot } from './file-search.js';
import { readTextFilePaginated } from './read-file-lines.js';
import type { Tool } from '../index.js';

function parseBool(raw: unknown): boolean {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function formatSearchHits(hits: ReturnType<typeof searchFilesUnderRoot>): string {
  if (hits.length === 0) return '（无匹配）';
  return hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n');
}

export const listPeerWorkspacesTool: Tool = {
  name: 'list_peer_workspaces',
  description:
    'List same-KPI peer workspaces (read-only, fully transparent). ' +
    'See `.inbox/README.md` for deliverable names + summaries; use read_peer_file for full content.',
  parameters: {},
  required: [],
  async call(): Promise<{ ok: boolean; output: string }> {
    const peers = listPeerWorkspaces();
    if (peers.length === 0) {
      return { ok: true, output: '（当前无 peer workspace；挂 kpi_id 时默认同 KPI sibling 互读）' };
    }
    const lines = peers.map((p) => `- ${p.workspace_id} → ${p.work_dir}`);
    return { ok: true, output: lines.join('\n') };
  },
};

function parseOptionalInt(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const readPeerFileTool: Tool = {
  name: 'read_peer_file',
  description:
    'Read a text file from a same-KPI peer workspace (read-only, paginated). ' +
    'Check `.inbox/README.md` for names/summaries first.',
  parameters: {
    workspace_id: { type: 'string', description: 'Peer workspace id, e.g. task-ib-mpqmx0v5-9a32' },
    path: { type: 'string', description: 'Path relative to that workspace root' },
    offset_line: { type: 'number', description: '1-based start line (default 1)' },
    limit_lines: { type: 'number', description: 'Max lines (default 200, max 500)' },
  },
  required: ['workspace_id', 'path'],
  async call(args): Promise<{ ok: boolean; output: string }> {
    const wsId = String(args['workspace_id'] ?? '').trim();
    const rel  = String(args['path'] ?? '').trim();
    if (!wsId || !rel) return { ok: false, output: 'Missing workspace_id or path' };
    const abs = resolvePeerReadPath(wsId, rel);
    if (!abs) return { ok: false, output: `Peer workspace 不可读或路径非法：${wsId}/${rel}` };
    return readTextFilePaginated(abs, {
      offsetLine: parseOptionalInt(args['offset_line']),
      limitLines: parseOptionalInt(args['limit_lines']),
    });
  },
};

export const listPeerFilesTool: Tool = {
  name: 'list_peer_files',
  description: 'List files in a peer workspace (read-only). Skips .git, node_modules, heavy .run logs.',
  parameters: {
    workspace_id: { type: 'string', description: 'Peer workspace id' },
    path: { type: 'string', description: 'Subdirectory (default ".")' },
    glob: { type: 'string', description: 'Optional filename glob, e.g. "*.md"' },
    max_entries: { type: 'string', description: 'Max files (default 80)' },
  },
  required: ['workspace_id'],
  async call(args): Promise<{ ok: boolean; output: string }> {
    const wsId = String(args['workspace_id'] ?? '').trim();
    if (!wsId) return { ok: false, output: 'Missing workspace_id' };
    const root = resolvePeerReadPath(wsId, '.');
    if (!root) return { ok: false, output: `Unknown peer workspace: ${wsId}` };
    const maxEntries = Math.min(Math.max(parseInt(String(args['max_entries'] ?? '80'), 10) || 80, 1), 300);
    const files = listFilesUnderRoot(root, {
      subdir: args['path'] != null ? String(args['path']) : '.',
      glob: args['glob'] != null ? String(args['glob']) : undefined,
      maxEntries,
    });
    if (files.length === 0) return { ok: true, output: '（无文件）' };
    return { ok: true, output: files.join('\n') };
  },
};

export const searchPeerFilesTool: Tool = {
  name: 'search_peer_files',
  description: 'Search file contents in a peer workspace (read-only). Same semantics as search_files.',
  parameters: {
    workspace_id: { type: 'string', description: 'Peer workspace id' },
    query: { type: 'string', description: 'Search pattern' },
    path: { type: 'string', description: 'Subdirectory under peer root (default ".")' },
    glob: { type: 'string', description: 'Filename glob filter' },
    max_results: { type: 'string', description: 'Max hits (default 50)' },
    literal: { type: 'string', description: 'true = literal match' },
  },
  required: ['workspace_id', 'query'],
  async call(args): Promise<{ ok: boolean; output: string }> {
    const wsId = String(args['workspace_id'] ?? '').trim();
    const query = String(args['query'] ?? '').trim();
    if (!wsId || !query) return { ok: false, output: 'Missing workspace_id or query' };
    const root = resolvePeerReadPath(wsId, '.');
    if (!root) return { ok: false, output: `Unknown peer workspace: ${wsId}` };
    const maxN = Math.min(Math.max(parseInt(String(args['max_results'] ?? '50'), 10) || 50, 1), 200);
    const hits = searchFilesUnderRoot({
      root,
      query,
      subdir: args['path'] != null ? String(args['path']) : '.',
      glob: args['glob'] != null ? String(args['glob']) : undefined,
      maxResults: maxN,
      literal: parseBool(args['literal']),
    });
    return { ok: true, output: formatSearchHits(hits) };
  },
};
