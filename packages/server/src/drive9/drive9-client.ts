import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Drive9Client — HTTP client for drive9 network filesystem
 *
 * API base: https://api.drive9.ai/v1/fs/{path}
 * Auth:     Authorization: Bearer {apiKey}
 *
 * Operations:
 *   GET    /v1/fs/{path}              → read file content
 *   GET    /v1/fs/{path}?list=1       → list directory entries
 *   HEAD   /v1/fs/{path}              → stat (size, isdir, revision)
 *   PUT    /v1/fs/{path}              → write file
 *   DELETE /v1/fs/{path}              → delete file
 *   POST   /v1/fs/{dst}?copy          + X-Dat9-Copy-Source: {src} → zero-copy
 *   POST   /v1/fs/{new}?rename        + X-Dat9-Rename-Source: {old} → rename
 *   GET    /v1/fs/{prefix}?grep={q}   → semantic search (vector + BM25)
 *   GET    /v1/fs/{prefix}?list=1     → list entries
 *
 * Drive9 stores files verbatim — no LLM transformation.
 * Semantic search is powered by TiDB auto-embedding (same backend as mem9).
 */

export interface Drive9Config {
  apiUrl?: string;   // default: https://api.drive9.ai
  apiKey: string;
}

export interface ResolvedDrive9Config extends Drive9Config {
  source: 'env' | 'cli-config';
  contextName?: string;
  configPath?: string;
}

export interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
}

export interface SearchResult {
  path: string;
  name: string;
  size_bytes: number;
  score?: number;
}

export class Drive9Error extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'Drive9Error';
  }
}

export class Drive9Client {
  private readonly base: string;
  private readonly apiKey: string;

  constructor(config: Drive9Config) {
    this.base   = (config.apiUrl ?? 'https://api.drive9.ai').replace(/\/$/, '') + '/v1/fs';
    this.apiKey = config.apiKey;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { 'Authorization': `Bearer ${this.apiKey}`, ...extra };
  }

  private url(path: string): string {
    return this.base + (path.startsWith('/') ? path : `/${path}`);
  }

  /** Read file content as string. */
  async read(path: string): Promise<string> {
    const res = await fetch(this.url(path), { headers: this.headers() });
    if (!res.ok) throw new Drive9Error(`read ${path}: ${res.status}`, res.status);
    return res.text();
  }

  /** Write file content. */
  async write(path: string, content: string): Promise<void> {
    const res = await fetch(this.url(path), {
      method:  'PUT',
      headers: this.headers({ 'Content-Type': 'application/octet-stream' }),
      body:    content,
    });
    if (!res.ok) throw new Drive9Error(`write ${path}: ${res.status}`, res.status);
  }

  /** Delete a file. */
  async delete(path: string): Promise<void> {
    const res = await fetch(this.url(path), {
      method:  'DELETE',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Drive9Error(`delete ${path}: ${res.status}`, res.status);
    }
  }

  /** Check if a path exists. */
  async exists(path: string): Promise<boolean> {
    const res = await fetch(this.url(path), { method: 'HEAD', headers: this.headers() });
    return res.status === 200;
  }

  /** List directory entries. */
  async list(dirPath: string): Promise<FileEntry[]> {
    const p = dirPath.endsWith('/') ? dirPath : dirPath + '/';
    const res = await fetch(this.url(p) + '?list=1', { headers: this.headers() });
    if (res.status === 404) return [];
    if (!res.ok) throw new Drive9Error(`list ${dirPath}: ${res.status}`, res.status);
    const data = await res.json() as { entries: FileEntry[] } | null;
    return data?.entries ?? [];
  }

  /**
   * Semantic search under a path prefix.
   * Uses vector similarity + BM25 hybrid — finds by meaning, not just keyword.
   */
  async grep(query: string, pathPrefix = '/', limit = 10): Promise<SearchResult[]> {
    const prefix = pathPrefix.endsWith('/') ? pathPrefix : pathPrefix + '/';
    const url    = this.url(prefix) + `?grep=${encodeURIComponent(query)}&limit=${limit}`;
    const res    = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Drive9Error(`grep ${pathPrefix}: ${res.status}`, res.status);
    const data = await res.json() as SearchResult[] | null;
    return data ?? [];
  }

  /**
   * Zero-copy server-side copy (no re-upload, no extra storage).
   */
  async copy(srcPath: string, dstPath: string): Promise<void> {
    const res = await fetch(this.url(dstPath) + '?copy', {
      method:  'POST',
      headers: this.headers({ 'X-Dat9-Copy-Source': srcPath }),
    });
    if (!res.ok) throw new Drive9Error(`copy ${srcPath}->${dstPath}: ${res.status}`, res.status);
  }
}

// ── 模块级单例 ────────────────────────────────────────────────────────────────

let _instance: Drive9Client | null | undefined;

interface Drive9CliContext {
  server?: string;
  api_key?: string;
}

interface Drive9CliConfig {
  server?: string;
  current_context?: string;
  contexts?: Record<string, Drive9CliContext>;
}

function resolveDrive9ConfigPath(): string {
  return path.join(os.homedir(), '.drive9', 'config');
}

function readDrive9CliConfig(): ResolvedDrive9Config | null {
  const configPath = resolveDrive9ConfigPath();
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Drive9CliConfig;
    const currentName = raw.current_context?.trim();
    if (!currentName) return null;
    const current = raw.contexts?.[currentName];
    const apiKey = current?.api_key?.trim();
    if (!apiKey) return null;
    return {
      apiKey,
      apiUrl: current?.server?.trim() || raw.server?.trim() || undefined,
      source: 'cli-config',
      contextName: currentName,
      configPath,
    };
  } catch {
    return null;
  }
}

export function resolveDrive9Config(): ResolvedDrive9Config | null {
  const apiKey = process.env['DRIVE9_API_KEY']?.trim();
  const apiUrl = process.env['DRIVE9_SERVER']?.trim() || undefined;
  if (apiKey) {
    return {
      apiKey,
      apiUrl,
      source: 'env',
    };
  }
  const fromCli = readDrive9CliConfig();
  if (!fromCli) return null;
  return {
    ...fromCli,
    apiUrl: apiUrl ?? fromCli.apiUrl,
  };
}

/**
 * 懒加载全局单例。优先读 DRIVE9_* 环境变量；未配置时回退到 ~/.drive9/config 当前 context。
 */
export function getDrive9Client(): Drive9Client | null {
  if (_instance !== undefined) return _instance;
  const resolved = resolveDrive9Config();
  if (!resolved) {
    _instance = null;
    return null;
  }
  _instance = new Drive9Client({ apiKey: resolved.apiKey, apiUrl: resolved.apiUrl });
  return _instance;
}

/**
 * 用指定 API key 初始化单例（由 index.ts 在启动时调用）。
 */
export function initDrive9Client(apiKey: string, apiUrl?: string): Drive9Client {
  _instance = new Drive9Client({ apiKey, apiUrl });
  return _instance;
}
