import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createLocalNodeStore } from './local-node-store.js';
import type { LocalNode } from './types.js';

function makeExecutorNode(id: string, overrides: Partial<LocalNode> = {}): LocalNode {
  return {
    id,
    version: '1.0.0',
    displayName: id,
    description: `desc of ${id}`,
    tags: ['t1'],
    interface: { inputs: [], outputs: [{ key: 'result', type: 'string' }] },
    body: { kind: 'executor', promptTemplate: 'do the thing', tools: ['read_file'] },
    metadata: { origin: 'creator', createdAt: '', updatedAt: '' },
    ...overrides,
  };
}

describe('localNodeStore', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-node-store-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('commit writes node, sets timestamps and indexes it', () => {
    const store = createLocalNodeStore(root);
    const saved = store.commit(makeExecutorNode('local/foo'));
    expect(saved.metadata.createdAt).not.toBe('');
    expect(saved.metadata.updatedAt).not.toBe('');
    expect(store.has('local/foo')).toBe(true);
    expect(store.read('local/foo')?.description).toBe('desc of local/foo');
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'local/foo', origin: 'creator', kind: 'executor' });
  });

  it('id with slashes maps to nested subdirectories', () => {
    const store = createLocalNodeStore(root);
    store.commit(makeExecutorNode('preset/base', { metadata: { origin: 'preset', createdAt: '', updatedAt: '' } }));
    expect(fs.existsSync(path.join(root, '.brain', 'local_nodes', 'preset', 'base.json'))).toBe(true);
  });

  it('rejects executor node without tools', () => {
    const store = createLocalNodeStore(root);
    const bad = makeExecutorNode('local/bad');
    (bad.body as { tools: string[] }).tools = [];
    expect(() => store.commit(bad)).toThrow(/tools allowlist/);
  });

  it('rejects path-traversal ids', () => {
    const store = createLocalNodeStore(root);
    expect(() => store.commit(makeExecutorNode('../evil'))).toThrow(/invalid LocalNode id/);
  });

  it('remove deletes file and index entry', () => {
    const store = createLocalNodeStore(root);
    store.commit(makeExecutorNode('local/foo'));
    store.remove('local/foo');
    expect(store.has('local/foo')).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it('rebuildIndex recovers entries from disk', () => {
    const store = createLocalNodeStore(root);
    store.commit(makeExecutorNode('local/a'));
    store.commit(makeExecutorNode('local/b'));
    // corrupt the index
    fs.writeFileSync(path.join(root, '.brain', 'local_nodes', 'index.json'), '{"entries":[],"updatedAt":"x"}', 'utf8');
    expect(store.list()).toHaveLength(0);
    const rebuilt = store.rebuildIndex();
    expect(rebuilt.entries.map(e => e.id).sort()).toEqual(['local/a', 'local/b']);
  });
});
