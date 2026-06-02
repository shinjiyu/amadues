/**
 * NodeDef Drive9 Store — drive9 `/nodes/shared/` 上 NodeDef 的读写与 index 维护。
 *
 * ADL：doc/structurizr/INNER-NODE-LIFECYCLE.md §5.4 §6 §7
 *
 * 布局：
 *   /nodes/shared/index.json                  — 元数据 + dedupeKey + status + 计数（canonical）
 *   /nodes/shared/defs/<id>@<version>.json     — 正文
 *   /nodes/shared/archive/<id>@<version>.json  — tombstone 归档
 *
 * 计数（cite/import/assembleFail）以 index 为权威，get() 时合并回 def.metadata。
 * 注入 Drive9Fs（Drive9Client 结构化兼容），便于用内存替身做单测。
 */

import crypto from 'node:crypto';

import type { NodeDef, NodeInterface, NodeBody } from '../openkuroneko/inner-brain/types.js';

/** Drive9Client 的最小子集，便于注入替身 */
export interface Drive9Fs {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<{ name: string; size: number; isDir: boolean }[]>;
  grep(query: string, pathPrefix?: string, limit?: number): Promise<{ path: string; name: string; score?: number }[]>;
  copy?(src: string, dst: string): Promise<void>;
}

export interface NodeDefIndexEntry {
  id: string;
  version: string;
  description: string;
  tags: string[];
  dedupeKey: string;
  status: 'active' | 'tombstone';
  citeCount: number;
  importCount: number;
  assembleFailCount: number;
  createdAt: string;
  lastImportedAt?: string;
}

export interface NodeDefIndex {
  entries: NodeDefIndexEntry[];
  updatedAt: string;
}

export interface NodeDefSearchOpts {
  topK?: number;
  filterTags?: string[];
}

export interface NodeDefDrive9Store {
  put(def: NodeDef): Promise<NodeDef>;
  get(id: string, version: string): Promise<NodeDef | null>;
  list(): Promise<NodeDefIndexEntry[]>;
  search(query: string, opts?: NodeDefSearchOpts): Promise<NodeDef[]>;
  findByDedupeKey(dedupeKey: string): Promise<NodeDefIndexEntry | null>;
  bumpCite(id: string, version: string): Promise<void>;
  bumpImport(id: string, version: string): Promise<void>;
  bumpAssembleFail(id: string, version: string): Promise<void>;
  tombstone(id: string, version: string): Promise<void>;
}

const ROOT = 'nodes/shared';
const INDEX_PATH = `${ROOT}/index.json`;

function defKey(id: string, version: string): string {
  return `${id}@${version}`;
}
function defPath(id: string, version: string): string {
  return `${ROOT}/defs/${defKey(id, version)}.json`;
}
function archivePath(id: string, version: string): string {
  return `${ROOT}/archive/${defKey(id, version)}.json`;
}

/** 稳定序列化（键排序），用于 dedupeKey 计算 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** body + interface 的结构 hash，用于去重 */
export function computeDedupeKey(body: NodeBody, iface: NodeInterface): string {
  return crypto.createHash('sha256').update(canonicalJson({ body, iface })).digest('hex');
}

export function createNodeDefDrive9Store(fs: Drive9Fs): NodeDefDrive9Store {
  async function readIndex(): Promise<NodeDefIndex> {
    try {
      const raw = await fs.read(INDEX_PATH);
      const parsed = JSON.parse(raw) as NodeDefIndex;
      if (parsed && Array.isArray(parsed.entries)) return parsed;
    } catch { /* missing / malformed */ }
    return { entries: [], updatedAt: new Date(0).toISOString() };
  }

  async function writeIndex(index: NodeDefIndex): Promise<void> {
    index.updatedAt = new Date().toISOString();
    await fs.write(INDEX_PATH, JSON.stringify(index, null, 2));
  }

  function entryFromDef(def: NodeDef): NodeDefIndexEntry {
    return {
      id: def.id,
      version: def.version,
      description: def.description,
      tags: def.tags ?? [],
      dedupeKey: def.metadata.dedupeKey,
      status: def.metadata.status,
      citeCount: def.metadata.citeCount,
      importCount: def.metadata.importCount,
      assembleFailCount: def.metadata.assembleFailCount,
      createdAt: def.metadata.createdAt,
      ...(def.metadata.lastImportedAt ? { lastImportedAt: def.metadata.lastImportedAt } : {}),
    };
  }

  async function mutateEntry(
    id: string,
    version: string,
    fn: (e: NodeDefIndexEntry) => void,
  ): Promise<void> {
    const index = await readIndex();
    const e = index.entries.find(x => x.id === id && x.version === version);
    if (!e) return;
    fn(e);
    await writeIndex(index);
  }

  return {
    async put(def: NodeDef): Promise<NodeDef> {
      await fs.write(defPath(def.id, def.version), JSON.stringify(def, null, 2));
      const index = await readIndex();
      const i = index.entries.findIndex(e => e.id === def.id && e.version === def.version);
      const entry = entryFromDef(def);
      if (i >= 0) index.entries[i] = entry;
      else index.entries.push(entry);
      await writeIndex(index);
      return def;
    },

    async get(id: string, version: string): Promise<NodeDef | null> {
      let def: NodeDef;
      try {
        def = JSON.parse(await fs.read(defPath(id, version))) as NodeDef;
      } catch {
        return null;
      }
      // 计数以 index 为权威
      const index = await readIndex();
      const e = index.entries.find(x => x.id === id && x.version === version);
      if (e) {
        def.metadata = {
          ...def.metadata,
          status: e.status,
          citeCount: e.citeCount,
          importCount: e.importCount,
          assembleFailCount: e.assembleFailCount,
          ...(e.lastImportedAt ? { lastImportedAt: e.lastImportedAt } : {}),
        };
      }
      return def;
    },

    async list(): Promise<NodeDefIndexEntry[]> {
      return (await readIndex()).entries;
    },

    async search(query: string, opts?: NodeDefSearchOpts): Promise<NodeDef[]> {
      const topK = opts?.topK ?? 20;
      const filterTags = opts?.filterTags;
      const index = await readIndex();
      const active = index.entries.filter(e => e.status === 'active');

      // 优先用 drive9 语义搜索定位 def 文件；失败/空则回退到 index 全量
      let orderedKeys: string[] = [];
      try {
        const hits = await fs.grep(query, `${ROOT}/defs/`, topK);
        orderedKeys = hits.map(h => h.name.replace(/\.json$/, ''));
      } catch { /* fallback below */ }

      let candidates: NodeDefIndexEntry[];
      if (orderedKeys.length > 0) {
        const byKey = new Map(active.map(e => [defKey(e.id, e.version), e]));
        candidates = orderedKeys.map(k => byKey.get(k)).filter((e): e is NodeDefIndexEntry => !!e);
      } else {
        candidates = active;
      }

      if (filterTags && filterTags.length > 0) {
        candidates = candidates.filter(e => filterTags.some(t => e.tags.includes(t)));
      }
      candidates = candidates.slice(0, topK);

      const defs: NodeDef[] = [];
      for (const e of candidates) {
        const def = await this.get(e.id, e.version);
        if (def) defs.push(def);
      }
      return defs;
    },

    async findByDedupeKey(dedupeKey: string): Promise<NodeDefIndexEntry | null> {
      const index = await readIndex();
      return index.entries.find(e => e.dedupeKey === dedupeKey && e.status === 'active') ?? null;
    },

    async bumpCite(id, version) {
      await mutateEntry(id, version, e => { e.citeCount += 1; });
    },
    async bumpImport(id, version) {
      await mutateEntry(id, version, e => { e.importCount += 1; e.lastImportedAt = new Date().toISOString(); });
    },
    async bumpAssembleFail(id, version) {
      await mutateEntry(id, version, e => { e.assembleFailCount += 1; });
    },

    async tombstone(id, version) {
      // 移动正文到 archive（copy + delete；无 copy 时 read→write→delete）
      try {
        if (fs.copy) {
          await fs.copy(defPath(id, version), archivePath(id, version));
        } else {
          const content = await fs.read(defPath(id, version));
          await fs.write(archivePath(id, version), content);
        }
        await fs.delete(defPath(id, version));
      } catch { /* best-effort move */ }
      await mutateEntry(id, version, e => { e.status = 'tombstone'; });
    },
  };
}
