/**
 * 解析 peer workspace 路径（set_goal / spawner 注入）。
 */
import fs from 'node:fs';
import path from 'node:path';

const WORKSPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function isValidWorkspaceId(workspaceId: string): boolean {
  return WORKSPACE_ID_RE.test(workspaceId);
}

export function resolvePeerWorkDir(workspacesRoot: string, workspaceId: string): string | null {
  const id = workspaceId.trim();
  if (!isValidWorkspaceId(id)) return null;
  const root = path.resolve(workspacesRoot);
  const abs = path.resolve(root, id);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

export function parsePeerWorkspaceIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function buildPeerWorkspaceEntries(
  workspacesRoot: string,
  workspaceIds: string[],
): Array<{ workspaceId: string; workDir: string }> {
  const entries: Array<{ workspaceId: string; workDir: string }> = [];
  for (const id of workspaceIds) {
    const workDir = resolvePeerWorkDir(workspacesRoot, id);
    if (workDir) entries.push({ workspaceId: id, workDir });
  }
  return entries;
}
