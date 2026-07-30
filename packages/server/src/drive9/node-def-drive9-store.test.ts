import { describe, expect, it, beforeEach } from 'vitest';

import {
  createNodeDefDrive9Store,
  computeDedupeKey,
  canonicalJson,
  type Drive9Fs,
} from './node-def-drive9-store.js';
import type { NodeDef } from '../openkuroneko/inner-brain/types.js';

/** 内存版 Drive9Fs 替身；grep 按 token 匹配路径/正文（空命中 → []，测「不回退全库」） */
function createMemFs(): Drive9Fs & { dump(): Record<string, string> } {
  const files = new Map<string, string>();
  return {
    async read(p) { const v = files.get(p); if (v === undefined) throw new Error(`404 ${p}`); return v; },
    async write(p, c) { files.set(p, c); },
    async delete(p) { files.delete(p); },
    async exists(p) { return files.has(p); },
    async list(dir) {
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      return [...files.keys()]
        .filter(k => k.startsWith(prefix))
        .map(k => ({ name: k.slice(prefix.length), size: 0, isDir: false }));
    },
    async grep(query, dir, topK = 5) {
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return [];
      const hits: { name: string; score: number }[] = [];
      for (const [k, content] of files) {
        if (!k.startsWith(prefix) || !k.endsWith('.json')) continue;
        const hay = `${k}\n${content}`.toLowerCase();
        if (tokens.some(t => hay.includes(t))) {
          hits.push({ name: k.slice(prefix.length), score: 1 });
        }
      }
      return hits.slice(0, topK);
    },
    async copy(src, dst) { const v = files.get(src); if (v !== undefined) files.set(dst, v); },
    dump() { return Object.fromEntries(files); },
  };
}

function makeDef(id: string, overrides: Partial<NodeDef> = {}): NodeDef {
  const body = { kind: 'executor' as const, promptTemplate: 'do ${{ WORK_DIR }}', tools: ['shell_exec'] };
  const iface = { inputs: [], outputs: [{ key: 'result', type: 'string' }] };
  return {
    id,
    version: '1.0.0',
    description: `def ${id}`,
    tags: ['battle'],
    placeholders: [{ name: 'WORK_DIR', kind: 'path', required: true }],
    interface: iface,
    body,
    metadata: {
      sourceAgent: 'agent-1',
      sourceLocalId: `local/${id}`,
      dedupeKey: computeDedupeKey(body, iface),
      citeCount: 0,
      importCount: 0,
      assembleFailCount: 0,
      createdAt: new Date().toISOString(),
      status: 'active',
    },
    ...overrides,
  };
}

describe('canonicalJson', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});

describe('nodeDefDrive9Store', () => {
  let fs: ReturnType<typeof createMemFs>;
  beforeEach(() => { fs = createMemFs(); });

  it('put writes def file and index entry', async () => {
    const store = createNodeDefDrive9Store(fs);
    await store.put(makeDef('ps_open'));
    expect(fs.dump()['nodes/shared/defs/ps_open@1.0.0.json']).toBeDefined();
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'ps_open', status: 'active' });
  });

  it('get merges canonical counts from index', async () => {
    const store = createNodeDefDrive9Store(fs);
    await store.put(makeDef('ps_open'));
    await store.bumpImport('ps_open', '1.0.0');
    await store.bumpCite('ps_open', '1.0.0');
    const def = await store.get('ps_open', '1.0.0');
    expect(def?.metadata.importCount).toBe(1);
    expect(def?.metadata.citeCount).toBe(1);
    expect(def?.metadata.lastImportedAt).toBeTruthy();
  });

  it('findByDedupeKey returns active match only', async () => {
    const store = createNodeDefDrive9Store(fs);
    const def = makeDef('ps_open');
    await store.put(def);
    const hit = await store.findByDedupeKey(def.metadata.dedupeKey);
    expect(hit?.id).toBe('ps_open');
    expect(await store.findByDedupeKey('nope')).toBeNull();
  });

  it('tombstone moves file to archive and flips status', async () => {
    const store = createNodeDefDrive9Store(fs);
    await store.put(makeDef('ps_open'));
    await store.tombstone('ps_open', '1.0.0');
    expect(fs.dump()['nodes/shared/defs/ps_open@1.0.0.json']).toBeUndefined();
    expect(fs.dump()['nodes/shared/archive/ps_open@1.0.0.json']).toBeDefined();
    const list = await store.list();
    expect(list[0]?.status).toBe('tombstone');
  });

  it('search returns [] when grep empty — no full-catalog dump', async () => {
    const store = createNodeDefDrive9Store(fs);
    await store.put(makeDef('a', { tags: ['battle'] }));
    await store.put(makeDef('b', { tags: ['research'] }));
    // query 与正文均无交集 → 不得回退成 active 全表
    expect(await store.search('zzzz_no_such_token')).toHaveLength(0);
  });

  it('search returns grep hits and applies filterTags', async () => {
    const store = createNodeDefDrive9Store(fs);
    await store.put(makeDef('a', { tags: ['battle'] }));
    await store.put(makeDef('b', { tags: ['research'] }));
    // token "battle" 命中 a 的 tags；再 filterTags 收窄
    const battles = await store.search('battle', { filterTags: ['battle'] });
    expect(battles.map(d => d.id)).toEqual(['a']);
    const none = await store.search('battle', { filterTags: ['research'] });
    expect(none).toHaveLength(0);
  });

  it('search excludes tombstoned defs', async () => {
    const store = createNodeDefDrive9Store(fs);
    await store.put(makeDef('a'));
    await store.tombstone('a', '1.0.0');
    expect(await store.search('def a')).toHaveLength(0);
  });
});
