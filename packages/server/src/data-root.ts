import path from 'node:path';

/** Resolve agent DATA_ROOT: relative paths are under repo root; absolute paths (e.g. /data in Docker) pass through. */
export function resolveDataRoot(repoRoot: string, serverDir: string, envRoot?: string): string {
  if (!envRoot) return path.join(serverDir, '..', 'data');
  return path.isAbsolute(envRoot) ? envRoot : path.resolve(repoRoot, envRoot);
}

/**
 * Remap registry workDir written under Docker `/data` to the current DATA_ROOT.
 * Lets the same `data-yuanbao` tree run locally without junction hacks.
 */
export function resolveStoredWorkDir(workDir: string, dataRoot: string): string {
  const normalized = workDir.replace(/\\/g, '/');
  if (normalized === '/data') return dataRoot;
  if (!normalized.startsWith('/data/')) return workDir;
  const suffix = normalized.slice('/data/'.length);
  if (!suffix) return dataRoot;
  return path.join(dataRoot, ...suffix.split('/'));
}
