import type { Drive9Status, FileEntry, SearchResult } from './types.js';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const j = (await r.json()) as T & { ok?: boolean; error?: string };
  if (!r.ok || j.ok === false) {
    throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  }
  return j;
}

export async function fetchStatus(): Promise<Drive9Status> {
  return api<Drive9Status>('/api/status');
}

export async function listDir(dirPath: string): Promise<{ path: string; entries: FileEntry[] }> {
  return api(`/api/list?path=${encodeURIComponent(dirPath)}`);
}

export async function readFile(filePath: string): Promise<{ path: string; content: string }> {
  return api(`/api/read?path=${encodeURIComponent(filePath)}`);
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  await api('/api/write', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, content }),
  });
}

export async function deleteFile(filePath: string): Promise<void> {
  await api(`/api/delete?path=${encodeURIComponent(filePath)}`);
}

export async function searchFiles(
  q: string,
  prefix = '/',
  limit = 30,
): Promise<{ query: string; prefix: string; results: SearchResult[] }> {
  const params = new URLSearchParams({ q, prefix, limit: String(limit) });
  return api(`/api/search?${params}`);
}

export function joinPath(dir: string, name: string): string {
  const base = dir.endsWith('/') ? dir : `${dir}/`;
  return `${base}${name}`;
}

export function parentPath(p: string): string {
  const trimmed = p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx + 1);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return '📁';
  if (name.endsWith('.md')) return '📝';
  if (name.endsWith('.json')) return '📋';
  if (name.endsWith('.py') || name.endsWith('.ts') || name.endsWith('.js')) return '💻';
  if (name.endsWith('.txt')) return '📄';
  return '📎';
}
