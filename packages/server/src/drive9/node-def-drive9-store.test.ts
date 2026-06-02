import { describe, expect, it, beforeEach } from 'vitest';

import {
  createNodeDefDrive9Store,
  computeDedupeKey,
  canonicalJson,
  type Drive9Fs,
} from './node-def-drive9-store.js';
import type { NodeDef } from '../openkuroneko/inner-brain/types.js';

/** 内存版 Drive9Fs 替身 */
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
    async grep() { return []; },
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

  it('search falls back to index when grep empty and filters by tag', async () => {
    const store = createNodeDefDrive9Store(fs);
    await store.put(makeDef('a', { tags: ['battle'] }));
    await store.put(makeDef('b', { tags: ['research'] }));
    const battles = await store.search('anything', { filterTags: ['battle'] });
    expect(battles.map(d => d.id)).toEqual(['a']);
  });

  it('search excludes tombstoned defs', async () => {
    const store = createNodeDefDrive9Store(fs);
    await store.put(makeDef('a'));
    await store.tombstone('a', '1.0.0');
    expect(await store.search('x')).toHaveLength(0);
  });
});
