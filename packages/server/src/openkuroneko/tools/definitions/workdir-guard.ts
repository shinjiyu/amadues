/**
 * 工作目录访问守卫
 *
 * 统一约束 read_file / write_file / edit_file / shell_exec 的路径访问范围。
 * workDir 和 allowedDirs 由 CLI 启动时调用 setWorkDirGuard() 注入。
 */

import path from 'node:path';

let _workDir: string = process.cwd();
let _allowedDirs: string[] = [];
// 临时目录也需要可读写（記忆、日志等）
let _tempDir: string | null = null;
/** 其它内脑 workspace：只读，供 read_peer_file / search_peer_files */
const _peerReadById = new Map<string, string>();

export function setWorkDirGuard(workDir: string, tempDir: string, allowedDirs: string[] = []): void {
  _workDir    = path.resolve(workDir);
  _tempDir    = path.resolve(tempDir);
  _allowedDirs = allowedDirs.map((d) => path.resolve(d));
}

/** 注册可只读访问的 peer workspace（跨内脑产物协议） */
export function setPeerWorkspaces(entries: Array<{ workspaceId: string; workDir: string }>): void {
  _peerReadById.clear();
  for (const e of entries) {
    const id = e.workspaceId.trim();
    if (!id) continue;
    _peerReadById.set(id, path.resolve(e.workDir));
  }
}

export function listPeerWorkspaces(): Array<{ workspace_id: string; work_dir: string }> {
  return [..._peerReadById.entries()].map(([workspace_id, work_dir]) => ({ workspace_id, work_dir }));
}

export function resolvePeerReadPath(workspaceId: string, relativePath: string): string | null {
  const root = _peerReadById.get(workspaceId.trim());
  if (!root) return null;
  const abs = path.resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function isPeerPathReadable(abs: string): boolean {
  for (const root of _peerReadById.values()) {
    if (abs === root || abs.startsWith(root + path.sep)) return true;
  }
  return false;
}

export function isPathAllowed(targetPath: string): boolean {
  const abs = path.resolve(targetPath);
  const roots = [_workDir, ...(_tempDir ? [_tempDir] : []), ..._allowedDirs];
  return roots.some((root) => abs === root || abs.startsWith(root + path.sep));
}

/** 本 workspace + peer workspace（只读侧） */
export function isPathReadable(targetPath: string): boolean {
  const abs = path.resolve(targetPath);
  return isPathAllowed(abs) || isPeerPathReadable(abs);
}

/** 仅本 workspace 可写；peer 永远不可写 */
export function isPathWritable(targetPath: string): boolean {
  return isPathAllowed(targetPath);
}

export function getWorkDir(): string {
  return _workDir;
}

export function getTempDir(): string {
  return _tempDir ?? _workDir;
}

export function pathSecurityError(targetPath: string): string {
  return (
    `Security violation: path "${path.resolve(targetPath)}" is outside allowed directories. ` +
    `workDir="${_workDir}"${_tempDir ? `, tempDir="${_tempDir}"` : ''}.`
  );
}
