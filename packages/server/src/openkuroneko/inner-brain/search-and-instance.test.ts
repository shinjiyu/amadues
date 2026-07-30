import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import type { Logger } from '../logger/index.js';
import { createNodeDefDrive9Store, computeDedupeKey, type Drive9Fs } from '../../drive9/node-def-drive9-store.js';
import { createLocalNodeStore } from './local-node-store.js';
import { createMemoryStore } from './memory-store.js';
import { createDesignerTools } from './designer-tools.js';
import type { NodeDef, NodeDefPlaceholder } from './types.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}
function createMemFs(): Drive9Fs {
  const files = new Map<string, string>();
  return {
    async read(p) { const v = files.get(p); if (v === undefined) throw new Error('404'); return v; },
    async write(p, c) { files.set(p, c); },
    async delete(p) { files.delete(p); },
    async exists(p) { return files.has(p); },
    async list() { return []; },
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
    async copy(s, d) { const v = files.get(s); if (v !== undefined) files.set(d, v); },
  };
}
function makeDef(
  id: string,
  placeholders: NodeDefPlaceholder[] = [{ name: 'WORK_DIR', kind: 'path', required: true }],
): NodeDef {
  const body = { kind: 'executor' as const, promptTemplate: 'work in ${{ WORK_DIR }}', tools: ['shell_exec'] };
  const iface = { inputs: [], outputs: [{ key: 'result', type: 'string' }] };
  return {
    id, version: '1.0.0', description: `def ${id}`, tags: ['battle'], placeholders,
    interface: iface, body,
    metadata: { sourceAgent: 'a', sourceLocalId: `local/${id}`, dedupeKey: computeDedupeKey(body, iface), citeCount: 0, importCount: 0, assembleFailCount: 0, createdAt: new Date().toISOString(), status: 'active' },
  };
}

describe('search_and_instance designer tool', () => {
  let root = '';
  let fs2: Drive9Fs;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-inst-')); fs2 = createMemFs(); });
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('is not registered without sharing deps', () => {
    const { registry } = createDesignerTools({
      store: createLocalNodeStore(root), memory: createMemoryStore(root), workDir: root, burstId: 'b1',
    });
    expect(registry.get('search_and_instance')).toBeUndefined();
  });

  it('instances multiple defs, tolerating partial failures', async () => {
    const defStore = createNodeDefDrive9Store(fs2);
    await defStore.put(makeDef('good_one'));
    await defStore.put(makeDef('bad_one', [{ name: 'NEEDS_ACCOUNT', kind: 'account', required: true }]));
    const localStore = createLocalNodeStore(root);

    // binding LLM: supply WORK_DIR (good) but never NEEDS_ACCOUNT (bad fails)
    const llm = createFakeLLM([{ match: () => true, reply: { content: JSON.stringify({ binding: { WORK_DIR: '/w' } }) } }]);
    const { registry } = createDesignerTools({
      store: localStore, memory: createMemoryStore(root), workDir: root, burstId: 'b1',
      sharing: { defStore, llm, logger: silentLogger() },
    });

    const tool = registry.get('search_and_instance')!;
    const out = await tool.call({ query: 'open battle' });
    const parsed = JSON.parse(out.output) as { instanced: { defId: string }[]; failed: { defId: string }[] };
    expect(parsed.instanced.map(i => i.defId)).toContain('good_one');
    expect(parsed.failed.map(f => f.defId)).toContain('bad_one');
    expect(localStore.has('imported/good_one@1.0.0')).toBe(true);
  });

  it('is idempotent across calls (already-imported skipped, no double importCount)', async () => {
    const defStore = createNodeDefDrive9Store(fs2);
    await defStore.put(makeDef('good_one'));
    const localStore = createLocalNodeStore(root);
    const llm = createFakeLLM([{ match: () => true, reply: { content: JSON.stringify({ binding: { WORK_DIR: '/w' } }) } }]);
    const { registry } = createDesignerTools({
      store: localStore, memory: createMemoryStore(root), workDir: root, burstId: 'b1',
      sharing: { defStore, llm, logger: silentLogger() },
    });
    const tool = registry.get('search_and_instance')!;
    await tool.call({ query: 'good_one' });
    await tool.call({ query: 'good_one' });
    expect((await defStore.list())[0]?.importCount).toBe(1);
  });

  it('returns empty instanced when grep misses (no catalog dump)', async () => {
    const defStore = createNodeDefDrive9Store(fs2);
    await defStore.put(makeDef('weibo_like'));
    const localStore = createLocalNodeStore(root);
    const llm = createFakeLLM([{ match: () => true, reply: { content: JSON.stringify({ binding: { WORK_DIR: '/w' } }) } }]);
    const { registry } = createDesignerTools({
      store: localStore, memory: createMemoryStore(root), workDir: root, burstId: 'b1',
      sharing: { defStore, llm, logger: silentLogger() },
    });
    const tool = registry.get('search_and_instance')!;
    const out = await tool.call({ query: 'twitter_html_gen_table_zzzz' });
    const parsed = JSON.parse(out.output) as { instanced: unknown[] };
    expect(parsed.instanced).toEqual([]);
    expect(localStore.has('imported/weibo_like@1.0.0')).toBe(false);
  });
});
