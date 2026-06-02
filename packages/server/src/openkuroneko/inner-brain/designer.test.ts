import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import type { Logger } from '../logger/index.js';
import { createLocalNodeStore } from './local-node-store.js';
import { createMemoryStore } from './memory-store.js';
import { runDesigner } from './designer.js';
import { readLocalDag } from './local-dag-store.js';
import { PRESET_BASE } from './preset-nodes.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

describe('runDesigner', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'designer-'));
  });
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  function setup() {
    const store = createLocalNodeStore(root);
    store.commit(PRESET_BASE);
    const memory = createMemoryStore(root);
    memory.patch('goal', 'collect weather data');
    return { store, memory };
  }

  it('commits a local_dag and returns kind=run', async () => {
    const { store, memory } = setup();
    const llm = createFakeLLM([
      {
        label: 'design',
        match: () => true,
        reply: {
          content: '',
          toolCalls: [{
            id: 'd1',
            name: 'commit_local_dag',
            args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: 'fetch weather' }] },
          }],
        },
      },
    ]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('run');
    if (outcome.kind === 'run') {
      expect(outcome.dag.nodes[0]?.ref).toBe('preset/base');
      expect(outcome.dag.burstId).toBe('b1');
    }
    expect(readLocalDag(root)?.nodes).toHaveLength(1);
  });

  it('rejects commit with non-existent ref then can retry', async () => {
    const { store, memory } = setup();
    const llm = createFakeLLM([
      {
        label: 'bad-then-good',
        match: ({ messages }) => messages.length === 1,
        reply: { content: '', toolCalls: [{ id: 'd1', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'local/ghost' }] } }] },
      },
      {
        label: 'good',
        match: () => true,
        reply: { content: '', toolCalls: [{ id: 'd2', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: 'do it' }] } }] },
      },
    ]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('run');
  });

  it('returns kind=done when designer reports done', async () => {
    const { store, memory } = setup();
    const llm = createFakeLLM([
      { match: () => true, reply: { content: '', toolCalls: [{ id: 'd1', name: 'report_done', args: { reason: 'already achieved' } }] } },
    ]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('done');
    if (outcome.kind === 'done') expect(outcome.reason).toContain('already achieved');
  });

  it('returns kind=empty when designer neither commits nor reports', async () => {
    const { store, memory } = setup();
    const llm = createFakeLLM([{ match: () => true, reply: { content: 'thinking but no action' } }]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('empty');
  });
});
