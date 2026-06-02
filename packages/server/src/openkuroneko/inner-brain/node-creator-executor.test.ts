import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import type { Logger } from '../logger/index.js';
import { createNodeDefDrive9Store, type Drive9Fs } from '../../drive9/node-def-drive9-store.js';
import { createLocalNodeStore } from './local-node-store.js';
import { runNodeCreator } from './node-creator-executor.js';
import { PRESET_NODE_CREATOR } from './preset-nodes.js';
import type { InnerMemory, NodeInst } from './types.js';

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

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function emptyMemory(): InnerMemory {
  return { constraints: [], facts: [], node_results: {}, last_failure: null };
}

const inst: NodeInst = {
  id: 'creator1',
  ref: 'preset/node_creator',
  params: { mode: 'pack', source_node_ids: ['n1', 'n2'] },
};

describe('runNodeCreator', () => {
  let root = '';
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-creator-')); });
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('packs a successful path into a new local/ node', async () => {
    const store = createLocalNodeStore(root);
    const llm = createFakeLLM([
      {
        label: 'commit',
        match: ({ messages }) => messages.length === 1,
        reply: {
          content: '',
          toolCalls: [{
            id: 'c1',
            name: 'commit_local_node',
            args: {
              id: 'ps_open_battle',
              description: 'open a pokemon showdown battle',
              promptTemplate: 'login then click challenge',
              tools: ['shell_exec', 'web_search'],
              outputs: [{ key: 'battleRoom', type: 'string' }],
            },
          }],
        },
      },
      { label: 'finish', match: () => true, reply: { content: 'packed done' } },
    ]);

    const outcome = await runNodeCreator(
      { node: PRESET_NODE_CREATOR, inst, memory: emptyMemory(), workDir: root },
      { llm, logger: silentLogger(), store },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.committedId).toBe('local/ps_open_battle');
    expect(store.has('local/ps_open_battle')).toBe(true);
    const saved = store.read('local/ps_open_battle')!;
    expect(saved.metadata.origin).toBe('creator');
    expect(saved.metadata.provenance?.fromNodeInsts).toEqual(['n1', 'n2']);
    expect(saved.metadata.export).toBe(true);
  });

  it('reports pack failure when nothing is committed', async () => {
    const store = createLocalNodeStore(root);
    const llm = createFakeLLM([{ match: () => true, reply: { content: 'PACK_ABORT: no stable pattern found' } }]);

    const outcome = await runNodeCreator(
      { node: PRESET_NODE_CREATOR, inst, memory: emptyMemory(), workDir: root },
      { llm, logger: silentLogger(), store },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.packError).toContain('no stable pattern');
    expect(outcome.failure?.nodeInstId).toBe('creator1');
  });

  it('auto-exports committed node to drive9 when autoExport provided', async () => {
    const store = createLocalNodeStore(root);
    const defStore = createNodeDefDrive9Store(createMemFs());
    const llm = createFakeLLM([
      {
        label: 'commit',
        match: ({ systemPrompt, messages }) => systemPrompt.includes('newNodeCreator') && messages.length === 1,
        reply: {
          content: '',
          toolCalls: [{
            id: 'c1', name: 'commit_local_node',
            args: { id: 'ps_open_battle', description: 'open ps battle', promptTemplate: 'cd /home/gin/w then login', tools: ['shell_exec'], outputs: [{ key: 'room', type: 'string' }] },
          }],
        },
      },
      { label: 'creator-finish', match: ({ systemPrompt }) => systemPrompt.includes('newNodeCreator'), reply: { content: 'packed done' } },
      {
        label: 'abstract',
        match: ({ systemPrompt }) => systemPrompt.includes('NodeDef 抽象器'),
        reply: { content: JSON.stringify({ defId: 'ps_open_battle', description: 'open battle', tags: ['battle'], sanitizedBody: { kind: 'executor', promptTemplate: 'cd ${{ WORK_DIR }} then login', tools: ['shell_exec'] }, placeholders: [{ name: 'WORK_DIR', kind: 'path', required: true }] }) },
      },
    ]);

    const outcome = await runNodeCreator(
      { node: PRESET_NODE_CREATOR, inst, memory: emptyMemory(), workDir: root },
      { llm, logger: silentLogger(), store, autoExport: { defStore, sourceAgent: 'agent-gin', env: { workDir: '/home/gin/w' } } },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.exportPromise).toBeDefined();
    const exp = await outcome.exportPromise!;
    expect(exp.ok).toBe(true);
    expect((await defStore.list()).map(e => e.id)).toContain('ps_open_battle');
  });
});
