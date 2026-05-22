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

export function setWorkDirGuard(workDir: string, tempDir: string, allowedDirs: string[] = []): void {
  _workDir    = path.resolve(workDir);
  _tempDir    = path.resolve(tempDir);
  _allowedDirs = allowedDirs.map((d) => path.resolve(d));
}

export function isPathAllowed(targetPath: string): boolean {
  const abs = path.resolve(targetPath);
  const roots = [_workDir, ...(_tempDir ? [_tempDir] : []), ..._allowedDirs];
  return roots.some((root) => abs === root || abs.startsWith(root + path.sep));
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
