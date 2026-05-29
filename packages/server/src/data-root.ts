import path from 'node:path';

/** Resolve agent DATA_ROOT: relative paths are under repo root; absolute paths (e.g. /data in Docker) pass through. */
export function resolveDataRoot(repoRoot: string, serverDir: string, envRoot?: string): string {
  if (!envRoot) return path.join(serverDir, '..', 'data');
  return path.isAbsolute(envRoot) ? envRoot : path.resolve(repoRoot, envRoot);
}
