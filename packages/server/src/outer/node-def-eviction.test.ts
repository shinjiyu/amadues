import { describe, expect, it, beforeEach } from 'vitest';

import {
  createNodeDefDrive9Store,
  computeDedupeKey,
  type Drive9Fs,
  type NodeDefIndexEntry,
} from '../drive9/node-def-drive9-store.js';
import { runNodeDefEviction, scoreEntry, DEFAULT_WEIGHTS } from './node-def-eviction.js';
import type { NodeDef } from '../openkuroneko/inner-brain/types.js';

function createMemFs(): Drive9Fs {
  const files = new Map<string, string>();
  return {
    async read(p) { const v = files.get(p); if (v === undefined) throw new Error('404'); return v; },
    async write(p, c) { files.set(p, c); },
    async delete(p) { files.delete(p); },
    async exists(p) { return files.has(p); },
    async list() { return []; },
    async grep() { return []; },
    async copy(s, d) { const v = files.get(s); if (v !== undefined) files.set(d, v); },
  };
}

let seq = 0;
function makeDef(id: string, opts: { createdAt?: string; importCount?: number; citeCount?: number; assembleFailCount?: number } = {}): NodeDef {
  const body = { kind: 'executor' as const, promptTemplate: `do ${id} ${seq++}`, tools: ['shell_exec'] };
  const iface = { inputs: [], outputs: [{ key: 'r', type: 'string' }] };
  return {
    id, version: '1.0.0', description: id, tags: [], placeholders: [],
    interface: iface, body,
    metadata: {
      sourceAgent: 'a', sourceLocalId: `local/${id}`, dedupeKey: computeDedupeKey(body, iface),
      citeCount: opts.citeCount ?? 0, importCount: opts.importCount ?? 0, assembleFailCount: opts.assembleFailCount ?? 0,
      createdAt: opts.createdAt ?? new Date().toISOString(), status: 'active',
    },
  };
}

const NOW = new Date('2026-06-02T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();

function entry(id: string, m: { importCount?: number; citeCount?: number; assembleFailCount?: number; createdAt: string }): NodeDefIndexEntry {
  return {
    id, version: '1.0.0', description: id, tags: [], dedupeKey: id, status: 'active',
    citeCount: m.citeCount ?? 0, importCount: m.importCount ?? 0, assembleFailCount: m.assembleFailCount ?? 0,
    createdAt: m.createdAt,
  };
}

describe('scoreEntry', () => {
  it('ranks heavily-imported recent defs above cold failing ones', () => {
    const hotE = entry('hot', { importCount: 10, citeCount: 5, createdAt: daysAgo(1) });
    const coldE = entry('cold', { importCount: 0, assembleFailCount: 4, createdAt: daysAgo(60) });
    expect(scoreEntry(hotE, NOW, DEFAULT_WEIGHTS)).toBeGreaterThan(scoreEntry(coldE, NOW, DEFAULT_WEIGHTS));
  });
});

describe('runNodeDefEviction', () => {
  let fs: Drive9Fs;
  beforeEach(() => { fs = createMemFs(); seq = 0; });

  it('tombstones cold defs (no imports, older than coldDays)', async () => {
    const store = createNodeDefDrive9Store(fs);
    await store.put(makeDef('old_unused', { importCount: 0, createdAt: daysAgo(40) }));
    await store.put(makeDef('old_used', { importCount: 3, createdAt: daysAgo(40) }));
    await store.put(makeDef('new_unused', { importCount: 0, createdAt: daysAgo(5) }));

    const res = await runNodeDefEviction(store, { now: NOW, coldDays: 30 });
    expect(res.tombstoned.map(t => t.id)).toEqual(['old_unused']);
    expect((await store.list()).find(e => e.id === 'old_unused')?.status).toBe('tombstone');
    expect((await store.list()).find(e => e.id === 'old_used')?.status).toBe('active');
  });

  it('enforces quota by evicting lowest-score defs down to headroom', async () => {
    const store = createNodeDefDrive9Store(fs);
    // 5 defs, max=4, headroom=0.5 → target floor(4*0.5)=2 → evict 3
    for (let i = 0; i < 5; i++) {
      await store.put(makeDef(`d${i}`, { importCount: i, createdAt: daysAgo(1) }));
    }
    const res = await runNodeDefEviction(store, { now: NOW, maxActive: 4, headroomRatio: 0.5, coldDays: 365 });
    expect(res.tombstoned.filter(t => t.reason === 'quota')).toHaveLength(3);
    // lowest importCount (d0,d1,d2) evicted, d3/d4 survive
    const active = (await store.list()).filter(e => e.status === 'active').map(e => e.id).sort();
    expect(active).toEqual(['d3', 'd4']);
  });

  it('no-op when under quota and nothing cold', async () => {
    const store = createNodeDefDrive9Store(fs);
    await store.put(makeDef('a', { importCount: 1, createdAt: daysAgo(2) }));
    const res = await runNodeDefEviction(store, { now: NOW, maxActive: 200, coldDays: 30 });
    expect(res.tombstoned).toHaveLength(0);
    expect(res.remainingActive).toBe(1);
  });
});
