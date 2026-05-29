/**
 * 工作区内文件内容搜索（纯 Node，不依赖 rg；Docker/Linux/Windows 一致）。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface FileSearchHit {
  path: string;
  line: number;
  text: string;
}

export interface FileSearchOptions {
  root: string;
  query: string;
  subdir?: string;
  glob?: string;
  maxResults?: number;
  literal?: boolean;
  maxFileBytes?: number;
}

const SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);
const SKIP_PATH_PREFIXES = ['.run/pi-mono/logs', '.run/telemetry'];

function matchesGlob(fileName: string, glob?: string): boolean {
  if (!glob || glob === '*' || glob === '*.*') return true;
  const g = glob.trim();
  if (g.startsWith('*.')) return fileName.endsWith(g.slice(1));
  if (g.includes('*')) {
    const re = new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return re.test(fileName);
  }
  return fileName === g;
}

function shouldSkipDir(relPosix: string, name: string): boolean {
  if (SKIP_DIR_NAMES.has(name)) return true;
  return SKIP_PATH_PREFIXES.some((p) => relPosix === p || relPosix.startsWith(`${p}/`));
}

function buildPattern(query: string, literal: boolean): RegExp {
  if (literal) {
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(esc);
  }
  try {
    return new RegExp(query);
  } catch {
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(esc);
  }
}

function isProbablyText(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (const b of sample) {
    if (b === 0) return false;
  }
  return true;
}

export function searchFilesUnderRoot(opts: FileSearchOptions): FileSearchHit[] {
  const root = path.resolve(opts.root);
  const subRoot = path.resolve(root, opts.subdir?.trim() || '.');
  if (!subRoot.startsWith(root + path.sep) && subRoot !== root) return [];

  const maxResults = Math.min(Math.max(opts.maxResults ?? 50, 1), 200);
  const maxFileBytes = opts.maxFileBytes ?? 512 * 1024;
  const pattern = buildPattern(opts.query, !!opts.literal);
  const hits: FileSearchHit[] = [];

  function walk(dir: string): void {
    if (hits.length >= maxResults) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (hits.length >= maxResults) return;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (shouldSkipDir(rel, ent.name)) continue;
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!matchesGlob(ent.name, opts.glob)) continue;
      let buf: Buffer;
      try {
        const st = fs.statSync(full);
        if (st.size > maxFileBytes) continue;
        buf = fs.readFileSync(full);
      } catch {
        continue;
      }
      if (!isProbablyText(buf)) continue;
      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= maxResults) return;
        const line = lines[i] ?? '';
        if (!pattern.test(line)) continue;
        hits.push({
          path: rel,
          line: i + 1,
          text: line.trimEnd().slice(0, 240),
        });
      }
    }
  }

  if (fs.existsSync(subRoot)) walk(subRoot);
  return hits;
}

export function listFilesUnderRoot(
  root: string,
  opts?: { subdir?: string; glob?: string; maxEntries?: number; maxDepth?: number },
): string[] {
  const absRoot = path.resolve(root);
  const subRoot = path.resolve(absRoot, opts?.subdir?.trim() || '.');
  if (!subRoot.startsWith(absRoot + path.sep) && subRoot !== absRoot) return [];

  const maxEntries = Math.min(Math.max(opts?.maxEntries ?? 100, 1), 500);
  const maxDepth = opts?.maxDepth ?? 4;
  const out: string[] = [];

  function walk(dir: string, depth: number): void {
    if (out.length >= maxEntries || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxEntries) return;
      const full = path.join(dir, ent.name);
      const rel = path.relative(absRoot, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        if (shouldSkipDir(rel, ent.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!matchesGlob(ent.name, opts?.glob)) continue;
      out.push(rel);
    }
  }

  if (fs.existsSync(subRoot)) walk(subRoot, 0);
  return out.sort();
}
