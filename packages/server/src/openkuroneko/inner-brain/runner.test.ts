import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import { createToolRegistry } from '../tools/index.js';
import type { Logger } from '../logger/index.js';
import { createLocalNodeStore } from './local-node-store.js';
import { createMemoryStore } from './memory-store.js';
import { runLocalDag, isCreatorNode } from './runner.js';
import type { RunnerDeps as Deps } from './runner.js';
import { PRESET_BASE, PRESET_NODE_CREATOR } from './preset-nodes.js';
import type { LocalDag, LocalNode } from './types.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

describe('isCreatorNode', () => {
  it('recognizes preset/node_creator and commit-only tools', () => {
    expect(isCreatorNode(PRESET_NODE_CREATOR)).toBe(true);
    expect(isCreatorNode(PRESET_BASE)).toBe(false);
  });
});

describe('runLocalDag', () => {
  let root = '';
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-')); });
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  function deps(llm: ReturnType<typeof createFakeLLM>): Deps {
    const store = createLocalNodeStore(root);
    store.commit(PRESET_BASE);
    return {
      llm,
      toolRegistry: createToolRegistry([]),
      store,
      memory: createMemoryStore(root),
      logger: silentLogger(),
      workDir: root,
    };
  }

  it('runs two baseNodes sequentially and records node_results', async () => {
    const llm = createFakeLLM([
      { label: 'n1', match: 'first task', reply: { content: 'first done' } },
      { label: 'n2', match: 'second task', reply: { content: 'second done' } },
    ]);
    const d = deps(llm);
    const dag: LocalDag = {
      burstId: 'b1',
      designedAt: 'now',
      nodes: [
        { id: 'n1', ref: 'preset/base', instruction: 'first task' },
        { id: 'n2', ref: 'preset/base', instruction: 'second task' },
      ],
    };
    const res = await runLocalDag(dag, d);
    expect(res.ok).toBe(true);
    expect(res.completed).toEqual(['n1', 'n2']);
    const mem = d.memory.read();
    expect(mem.node_results['n1']?.ok).toBe(true);
    expect(mem.node_results['n2']?.outputs?.['result']).toBe('second done');
  });

  it('stops at terminal failure and writes last_failure', async () => {
    const llm = createFakeLLM([
      { label: 'n1', match: 'good task', reply: { content: 'ok' } },
      { label: 'n2', match: 'bad task', reply: { content: 'CANNOT_CONTINUE: blocked' } },
      { label: 'n3', match: 'never', reply: { content: 'should not run' } },
    ]);
    const d = deps(llm);
    const dag: LocalDag = {
      burstId: 'b1',
      designedAt: 'now',
      nodes: [
        { id: 'n1', ref: 'preset/base', instruction: 'good task' },
        { id: 'n2', ref: 'preset/base', instruction: 'bad task' },
        { id: 'n3', ref: 'preset/base', instruction: 'never task' },
      ],
    };
    const res = await runLocalDag(dag, d);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe('n2');
    expect(res.completed).toEqual(['n1']);
    expect(d.memory.read().last_failure?.summary).toContain('blocked');
    // n3 must not have run
    expect(d.memory.read().node_results['n3']).toBeUndefined();
  });

  it('fails fast when ref is missing', async () => {
    const llm = createFakeLLM([{ match: () => true, reply: { content: 'x' } }]);
    const d = deps(llm);
    const dag: LocalDag = {
      burstId: 'b1', designedAt: 'now',
      nodes: [{ id: 'n1', ref: 'local/does_not_exist' }],
    };
    const res = await runLocalDag(dag, d);
    expect(res.ok).toBe(false);
    expect(res.failedAt).toBe('n1');
    expect(d.memory.read().last_failure?.summary).toContain('不存在');
  });

  it('expands a compound graph node and exports to parent memory', async () => {
    const store = createLocalNodeStore(root);
    store.commit(PRESET_BASE);
    const compound: LocalNode = {
      id: 'local/combo',
      version: '1.0.0',
      displayName: 'combo',
      description: 'two-step combo',
      tags: [],
      interface: { inputs: [], outputs: [{ key: 'final', type: 'string' }] },
      body: {
        kind: 'graph',
        nodes: [
          { id: 's1', ref: 'preset/base', instruction: 'sub one' },
          { id: 's2', ref: 'preset/base', instruction: 'sub two' },
        ],
        exports: [{ from: 's2.result', as: 'final' }],
      },
      metadata: { origin: 'creator', createdAt: '', updatedAt: '' },
    };
    store.commit(compound);
    const llm = createFakeLLM([
      { match: 'sub one', reply: { content: 'sub one done' } },
      { match: 'sub two', reply: { content: 'sub two done' } },
    ]);
    const d: Deps = {
      llm, toolRegistry: createToolRegistry([]), store,
      memory: createMemoryStore(root), logger: silentLogger(), workDir: root,
    };
    const dag: LocalDag = { burstId: 'b1', designedAt: 'now', nodes: [{ id: 'c1', ref: 'local/combo' }] };
    const res = await runLocalDag(dag, d);
    expect(res.ok).toBe(true);
    expect(d.memory.get('final')).toBe('sub two done');
  });
});
