import { describe, expect, it, beforeEach } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import type { Logger } from '../logger/index.js';
import { createNodeDefDrive9Store, type Drive9Fs } from '../../drive9/node-def-drive9-store.js';
import { abstractLocalNode, validateSanitized } from './node-abstractor.js';
import type { LocalNode, NodeBody } from './types.js';

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
    async grep() { return []; },
    async copy(s, d) { const v = files.get(s); if (v !== undefined) files.set(d, v); },
  };
}

function creatorNode(overrides: Partial<LocalNode> = {}): LocalNode {
  return {
    id: 'local/ps_open',
    version: '1.0.0',
    displayName: 'open battle',
    description: 'open a battle',
    tags: ['battle'],
    interface: { inputs: [], outputs: [{ key: 'room', type: 'string' }] },
    body: { kind: 'executor', promptTemplate: 'cd /home/gin/work then login as gin_bot', tools: ['shell_exec'] },
    metadata: { origin: 'creator', export: true, createdAt: '', updatedAt: '' },
    ...overrides,
  };
}

const goodReply = JSON.stringify({
  defId: 'ps_open_battle',
  description: 'open a pokemon showdown battle',
  tags: ['battle', 'ps'],
  sanitizedBody: { kind: 'executor', promptTemplate: 'cd ${{ WORK_DIR }} then login as ${{ PS_ACCOUNT }}', tools: ['shell_exec'] },
  placeholders: [
    { name: 'WORK_DIR', kind: 'path', required: true },
    { name: 'PS_ACCOUNT', kind: 'account', required: true },
  ],
});

describe('validateSanitized', () => {
  const body: NodeBody = { kind: 'executor', promptTemplate: 'go ${{ WORK_DIR }}', tools: ['shell_exec'] };
  it('passes clean sanitized body', () => {
    expect(validateSanitized(body, [{ name: 'WORK_DIR', kind: 'path', required: true }]).ok).toBe(true);
  });
  it('rejects when required placeholder missing in body', () => {
    expect(validateSanitized(body, [{ name: 'MISSING', kind: 'path', required: true }]).ok).toBe(false);
  });
  it('rejects leaked env literal', () => {
    const leaky: NodeBody = { kind: 'executor', promptTemplate: 'cd /home/gin/work', tools: ['x'] };
    const r = validateSanitized(leaky, [], { workDir: '/home/gin/work' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('残留');
  });
  it('rejects too many placeholders', () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ name: `P${i}`, kind: 'other' as const, required: false }));
    expect(validateSanitized(body, many).ok).toBe(false);
  });
});

describe('abstractLocalNode', () => {
  let fs: Drive9Fs;
  beforeEach(() => { fs = createMemFs(); });

  it('exports a creator node to a new NodeDef', async () => {
    const store = createNodeDefDrive9Store(fs);
    const llm = createFakeLLM([{ match: () => true, reply: { content: goodReply } }]);
    const res = await abstractLocalNode(creatorNode(), { llm, logger: silentLogger(), store }, {
      sourceAgent: 'agent-gin',
      env: { workDir: '/home/gin/work', accountHints: ['gin_bot'] },
    });
    expect(res.ok).toBe(true);
    expect(res.def?.id).toBe('ps_open_battle');
    expect((await store.list())).toHaveLength(1);
  });

  it('skips non-creator origin', async () => {
    const store = createNodeDefDrive9Store(fs);
    const llm = createFakeLLM([]);
    const res = await abstractLocalNode(
      creatorNode({ metadata: { origin: 'preset', createdAt: '', updatedAt: '' } }),
      { llm, logger: silentLogger(), store }, { sourceAgent: 'a' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('creator');
  });

  it('skips when export=false', async () => {
    const store = createNodeDefDrive9Store(fs);
    const llm = createFakeLLM([]);
    const res = await abstractLocalNode(
      creatorNode({ metadata: { origin: 'creator', export: false, createdAt: '', updatedAt: '' } }),
      { llm, logger: silentLogger(), store }, { sourceAgent: 'a' },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('export=false');
  });

  it('rejects export when sanitized leaks env literal', async () => {
    const store = createNodeDefDrive9Store(fs);
    const leakyReply = JSON.stringify({
      defId: 'leaky',
      sanitizedBody: { kind: 'executor', promptTemplate: 'cd /home/gin/work', tools: ['shell_exec'] },
      placeholders: [],
    });
    const llm = createFakeLLM([{ match: () => true, reply: { content: leakyReply } }]);
    const res = await abstractLocalNode(creatorNode(), { llm, logger: silentLogger(), store }, {
      sourceAgent: 'a', env: { workDir: '/home/gin/work' },
    });
    expect(res.ok).toBe(false);
    expect(await store.list()).toHaveLength(0);
  });

  it('dedupes equivalent body and bumps cite instead of new version', async () => {
    const store = createNodeDefDrive9Store(fs);
    const llm = createFakeLLM([{ match: () => true, reply: { content: goodReply } }]);
    const first = await abstractLocalNode(creatorNode(), { llm, logger: silentLogger(), store }, { sourceAgent: 'a' });
    expect(first.ok).toBe(true);
    const second = await abstractLocalNode(creatorNode({ id: 'local/ps_open_v2' }), { llm, logger: silentLogger(), store }, { sourceAgent: 'a' });
    expect(second.deduped).toBe(true);
    expect(await store.list()).toHaveLength(1);
    expect(second.def?.metadata.citeCount).toBe(1);
  });
});
