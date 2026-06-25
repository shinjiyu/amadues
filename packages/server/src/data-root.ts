import path from 'node:path';

/** Resolve agent DATA_ROOT: relative paths are under repo root; absolute paths (e.g. /data in Docker) pass through. */
export function resolveDataRoot(repoRoot: string, serverDir: string, envRoot?: string): string {
  if (!envRoot) return path.join(serverDir, '..', 'data');
  return path.isAbsolute(envRoot) ? envRoot : path.resolve(repoRoot, envRoot);
}

/**
 * Make an agent SID (e.g. `idp:agent:kuroneko`) safe to use as a file/dir name.
 * Colons and other reserved chars are illegal on Windows (NTFS treats `:` as an
 * Alternate Data Stream separator), so SID-derived paths must be sanitized to
 * stay cross-platform (Linux/Docker + Windows Sandbox).
 */
export function safeAgentSid(agentSid: string): string {
  return agentSid.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'default';
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
