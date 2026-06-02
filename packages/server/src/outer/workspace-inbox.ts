/**
 * 同 KPI 内脑 workspace 互读 + spawn 时写入 `.inbox/` 产物目录（仅名字与摘要，不传正文）。
 * ADL: doc/structurizr/INNER-WORKSPACE-INBOX.md
 */
import fs from 'node:fs';
import path from 'node:path';

import type { InnerBrainRegistry } from './inner-brain-registry.js';
import type { KpiRegistry } from './kpi-registry.js';
import { buildPeerWorkspaceEntries } from '../openkuroneko/tools/peer-workspace.js';

const DEFAULT_SUMMARY_MAX_CHARS = 280;

export interface CollectPeerOpts {
  registry: InnerBrainRegistry;
  excludeWorkspaceId: string;
  explicitPeerIds?: string[];
  kpiId?: string;
  kpiRegistry?: KpiRegistry;
}

export interface PeerCatalogFile {
  path: string;
  bytes: number;
  summary: string;
}

export interface PeerWorkspaceCatalog {
  workspace_id: string;
  goal?: string;
  files: PeerCatalogFile[];
}

export interface WritePeerCatalogResult {
  fileCount: number;
  peerWorkspaceIds: string[];
  readmePath: string;
  catalogPath: string;
}

/** 解析 spawn 时应挂载的 peer workspace id（去重、有序）。 */
export function collectPeerWorkspaceIds(opts: CollectPeerOpts): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (id: string | undefined) => {
    const trimmed = id?.trim();
    if (!trimmed || trimmed === opts.excludeWorkspaceId || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  for (const id of opts.explicitPeerIds ?? []) add(id);

  // 同 KPI：默认全部 sibling workspace 完全互读
  if (opts.kpiId && opts.kpiRegistry) {
    const kpi = opts.kpiRegistry.get(opts.kpiId);
    for (const instanceId of kpi?.bursts ?? []) {
      const row = opts.registry.get(instanceId);
      if (row) add(row.workspaceId);
    }
  }

  return out;
}

/** @deprecated 使用 collectPeerWorkspaceIds */
export const collectUpstreamWorkspaceIds = collectPeerWorkspaceIds;

/** 上游 workspace 是否登记过可 handoff 的产物。 */
export function hasRegisteredDeliverables(workDir: string): boolean {
  return readDeliverableRelativePaths(workDir).length > 0;
}

/** 合并 deliverables.log + pi-mono/deliverables.json，去重保留字典序稳定列表。 */
export function readDeliverableRelativePaths(workDir: string): string[] {
  const latestByPath = new Map<string, string>();

  const logPath = path.join(workDir, '.run', 'deliverables.log');
  if (fs.existsSync(logPath)) {
    for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { event?: string; path?: string; ts?: string };
        if (j.event !== 'ingest_ok' || !j.path) continue;
        const rel = normalizeRelativePath(String(j.path));
        if (rel) latestByPath.set(rel, j.ts ?? '');
      } catch {
        /* skip malformed line */
      }
    }
  }

  const jsonPath = path.join(workDir, '.run', 'pi-mono', 'deliverables.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item !== 'string') continue;
          const rel = normalizeRelativePath(item);
          if (rel) latestByPath.set(rel, latestByPath.get(rel) ?? '');
        }
      }
    } catch {
      /* ignore */
    }
  }

  return [...latestByPath.keys()].sort();
}

function normalizeRelativePath(raw: string): string | null {
  const normalized = path.normalize(raw.trim()).replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  return normalized;
}

/** 读取文本文件开头作为摘要（不传正文到 spawn 上下文）。 */
export function summarizeTextFile(absPath: string, maxChars = DEFAULT_SUMMARY_MAX_CHARS): string {
  const st = fs.statSync(absPath);
  if (!st.isFile()) return '';
  if (st.size === 0) return '（空文件）';

  const head = Buffer.alloc(Math.min(st.size, 4096));
  const fd = fs.openSync(absPath, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  if (head.includes(0)) {
    return `[二进制或非 UTF-8，${st.size} bytes]`;
  }

  const text = head.toString('utf8').replace(/\s+/g, ' ').trim();
  if (!text) return `[${st.size} bytes]`;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function buildPeerCatalogForWorkspace(
  workspaceId: string,
  workDir: string,
  goal?: string,
): PeerWorkspaceCatalog | null {
  const files: PeerCatalogFile[] = [];

  for (const rel of readDeliverableRelativePaths(workDir)) {
    const abs = path.join(workDir, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const bytes = fs.statSync(abs).size;
    files.push({
      path: rel,
      bytes,
      summary: summarizeTextFile(abs),
    });
  }

  if (files.length === 0) return null;
  return { workspace_id: workspaceId, goal, files };
}

function formatCatalogMarkdown(catalog: PeerWorkspaceCatalog[]): string {
  const lines = [
    '# KPI peer catalog（只含名字与摘要）',
    '',
    '同 KPI 的 sibling workspace **完全互读**：用 `read_peer_file` / `list_peer_files` / `search_peer_files` 按需取正文。',
    '本目录**不复制**上游文件正文，仅便于发现已有产物。',
    '',
  ];

  for (const peer of catalog) {
    lines.push(`## ${peer.workspace_id}`);
    if (peer.goal) lines.push('', `> ${peer.goal.replace(/\n/g, ' ').slice(0, 200)}`, '');
    for (const f of peer.files) {
      lines.push(`- \`${f.path}\` (${f.bytes} bytes) — ${f.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** 写入 `.inbox/catalog.json` + `README.md`（无文件复制）。 */
export function writePeerCatalog(
  targetWorkDir: string,
  peers: Array<{ workspaceId: string; workDir: string; goal?: string }>,
): WritePeerCatalogResult {
  const inboxRoot = path.join(targetWorkDir, '.inbox');
  fs.mkdirSync(inboxRoot, { recursive: true });

  const catalog: PeerWorkspaceCatalog[] = [];
  const peerWorkspaceIds: string[] = [];
  let fileCount = 0;

  for (const peer of peers) {
    peerWorkspaceIds.push(peer.workspaceId);
    const entry = buildPeerCatalogForWorkspace(peer.workspaceId, peer.workDir, peer.goal);
    if (!entry) continue;
    fileCount += entry.files.length;
    catalog.push(entry);
  }

  const catalogPath = path.join(inboxRoot, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify({ peers: catalog }, null, 2), 'utf8');

  const readmePath = path.join(inboxRoot, 'README.md');
  const readme =
    catalog.length > 0
      ? formatCatalogMarkdown(catalog)
      : [
          '# KPI peer catalog',
          '',
          '同 KPI sibling workspace 已挂载为 peer（`list_peer_workspaces`）。',
          '当前 peer 尚无登记 deliverables；可用 `list_peer_files` 浏览。',
          '',
        ].join('\n');
  fs.writeFileSync(readmePath, readme, 'utf8');

  return { fileCount, peerWorkspaceIds, readmePath, catalogPath };
}

export function buildPeerEntriesWithGoals(
  registry: InnerBrainRegistry,
  workspacesRoot: string,
  workspaceIds: string[],
): Array<{ workspaceId: string; workDir: string; goal?: string }> {
  const byWsId = new Map(registry.list().map((r) => [r.workspaceId, r]));
  return buildPeerWorkspaceEntries(workspacesRoot, workspaceIds).map((e) => ({
    ...e,
    goal: byWsId.get(e.workspaceId)?.goal,
  }));
}

/** set_goal / resume 调用入口：写目录 + 返回 peer ids。 */
export function prepareKpiPeerHandoff(
  targetWorkDir: string,
  workspacesRoot: string,
  registry: InnerBrainRegistry,
  workspaceIds: string[],
): WritePeerCatalogResult {
  const peers = buildPeerEntriesWithGoals(registry, workspacesRoot, workspaceIds);
  return writePeerCatalog(targetWorkDir, peers);
}
