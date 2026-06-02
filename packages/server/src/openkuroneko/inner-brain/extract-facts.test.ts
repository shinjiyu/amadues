import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import { createToolRegistry } from '../tools/index.js';
import type { Logger } from '../logger/index.js';
import { createLocalNodeStore } from './local-node-store.js';
import { createMemoryStore } from './memory-store.js';
import { runLocalDag } from './runner.js';
import type { RunnerDeps as Deps } from './runner.js';
import { PRESET_EXTRACT_FACTS } from './preset-nodes.js';
import type { LocalDag } from './types.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

describe('preset/extract_facts', () => {
  let root = '';
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-facts-')); });
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  function deps(llm: ReturnType<typeof createFakeLLM>): Deps {
    const store = createLocalNodeStore(root);
    store.commit(PRESET_EXTRACT_FACTS);
    return {
      llm,
      toolRegistry: createToolRegistry([]),
      store,
      memory: createMemoryStore(root),
      logger: silentLogger(),
      workDir: root,
    };
  }

  it('records discovered facts into memory.facts via injected record_fact tool', async () => {
    const llm = createFakeLLM([
      {
        label: 'record',
        match: ({ messages }) => messages.length === 1,
        reply: { content: '', toolCalls: [{ id: 'f1', name: 'record_fact', args: { fact: 'bot account is gin' } }] },
      },
      { label: 'finish', match: () => true, reply: { content: 'recorded facts' } },
    ]);
    const d = deps(llm);
    const dag: LocalDag = {
      burstId: 'b1',
      designedAt: 'now',
      nodes: [{ id: 'ef1', ref: 'preset/extract_facts', instruction: 'discover env facts' }],
    };
    const res = await runLocalDag(dag, d);
    expect(res.ok).toBe(true);
    expect(d.memory.read().facts).toContain('bot account is gin');
  });

  it('deduplicates repeated facts', async () => {
    const llm = createFakeLLM([
      {
        label: 'r1',
        match: ({ messages }) => messages.length === 1,
        reply: { content: '', toolCalls: [{ id: 'f1', name: 'record_fact', args: { fact: 'svc at :8080' } }] },
      },
      {
        label: 'r2',
        match: ({ messages }) => messages.length === 3,
        reply: { content: '', toolCalls: [{ id: 'f2', name: 'record_fact', args: { fact: 'svc at :8080' } }] },
      },
      { label: 'finish', match: () => true, reply: { content: 'done' } },
    ]);
    const d = deps(llm);
    const dag: LocalDag = {
      burstId: 'b1', designedAt: 'now',
      nodes: [{ id: 'ef1', ref: 'preset/extract_facts', instruction: 'discover' }],
    };
    await runLocalDag(dag, d);
    expect(d.memory.read().facts.filter(f => f === 'svc at :8080')).toHaveLength(1);
  });
});
