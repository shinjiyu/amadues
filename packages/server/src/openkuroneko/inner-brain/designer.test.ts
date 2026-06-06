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
            args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: 'fetch weather', deliverable: { summary: 'weather saved', checks: [{ kind: 'file', target: 'weather.json' }] } }] },
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
        reply: { content: '', toolCalls: [{ id: 'd2', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: 'do it', deliverable: { summary: 'done', checks: [{ kind: 'stdout_contains', target: 'OK' }] } }] } }] },
      },
    ]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('run');
  });

  it('commit_local_dag rejects oversized instruction / missing deliverable, then recovers', async () => {
    const { store, memory } = setup();
    const huge = 'x'.repeat(4100);
    const llm = createFakeLLM([
      {
        label: 'oversized',
        match: ({ messages }) => messages.length === 1,
        reply: { content: '', toolCalls: [{ id: 'd1', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: huge, deliverable: { summary: 's', checks: [{ kind: 'file', target: 'a.json' }] } }] } }] },
      },
      {
        label: 'no-deliverable',
        match: ({ messages }) => messages.length === 3,
        reply: { content: '', toolCalls: [{ id: 'd2', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: 'short' }] } }] },
      },
      {
        label: 'good',
        match: () => true,
        reply: { content: '', toolCalls: [{ id: 'd3', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: 'short', deliverable: { summary: 's', checks: [{ kind: 'file', target: 'a.json' }] } }] } }] },
      },
    ]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('run');
    if (outcome.kind === 'run') expect(outcome.dag.nodes[0]?.deliverable?.checks[0]?.kind).toBe('file');
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

  it('report_done verify gate: rejects fake completion, designer must commit instead', async () => {
    const { store, memory } = setup();
    const llm = createFakeLLM([
      {
        label: 'fake-done',
        match: ({ messages }) => messages.length === 1,
        reply: {
          content: '',
          toolCalls: [{
            id: 'd1',
            name: 'report_done',
            args: { reason: '已发布 5 章', verify: [{ kind: 'file', target: 'workspace/published.json', describe: '发布结果' }] },
          }],
        },
      },
      {
        label: 'recover-commit',
        match: () => true,
        reply: {
          content: '',
          toolCalls: [{ id: 'd2', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: '真正去发布章节', deliverable: { summary: '章节已发布', checks: [{ kind: 'file', target: 'workspace/published.json' }] } }] } }],
        },
      },
    ]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('run');
  });

  it('report_done verify gate: accepts when evidence file exists', async () => {
    const { store, memory } = setup();
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(root, 'workspace', 'published.json'), JSON.stringify({ count: 5 }), 'utf8');
    const llm = createFakeLLM([
      {
        match: () => true,
        reply: {
          content: '',
          toolCalls: [{
            id: 'd1',
            name: 'report_done',
            args: { reason: '已完成', verify: [{ kind: 'json_key', target: 'workspace/published.json#count' }] },
          }],
        },
      },
    ]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('done');
  });

  it('promote_local_node solidifies a node during DESIGN then commits a dag referencing it', async () => {
    const { store, memory } = setup();
    const llm = createFakeLLM([
      {
        label: 'promote',
        match: ({ messages }) => messages.length === 1,
        reply: {
          content: '',
          toolCalls: [{
            id: 'd1',
            name: 'promote_local_node',
            args: {
              id: 'fetch_weather',
              description: '抓取天气数据',
              promptTemplate: '调用天气 API 并保存 result.json',
              tools: ['*'],
            },
          }],
        },
      },
      {
        label: 'commit-using-promoted',
        match: () => true,
        reply: {
          content: '',
          toolCalls: [{ id: 'd2', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'local/fetch_weather', instruction: '跑一次', deliverable: { summary: '结果文件', checks: [{ kind: 'file', target: 'result.json' }] } }] } }],
        },
      },
    ]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('run');
    expect(store.has('local/fetch_weather')).toBe(true);
  });

  it('lock_milestone rejects when verify evidence is missing (does not lock)', async () => {
    const { store, memory } = setup();
    const llm = createFakeLLM([
      {
        match: ({ messages }) => messages.length === 1,
        reply: {
          content: '',
          toolCalls: [{
            id: 'd1',
            name: 'lock_milestone',
            args: { id: 'book_created', summary: '建书完成', verify: [{ kind: 'file', target: 'workspace/book.json' }] },
          }],
        },
      },
      { match: () => true, reply: { content: '', toolCalls: [{ id: 'd2', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: 'go', deliverable: { summary: 'ok', checks: [{ kind: 'stdout_contains', target: 'OK' }] } }] } }] } },
    ]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('run');
    expect(memory.read().locked_milestones ?? []).toHaveLength(0);
  });

  it('commit_local_dag rejects a node tagged with an already-locked milestone, then recovers', async () => {
    const { store, memory } = setup();
    memory.lockMilestone({ id: 'book_created', summary: '已建书', lockedAt: 'now' });
    const llm = createFakeLLM([
      {
        match: ({ messages }) => messages.length === 1,
        reply: {
          content: '',
          toolCalls: [{ id: 'd1', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: '再建一次书', milestone: 'book_created' }] } }],
        },
      },
      {
        match: () => true,
        reply: {
          content: '',
          toolCalls: [{ id: 'd2', name: 'commit_local_dag', args: { nodes: [{ id: 'n1', ref: 'preset/base', instruction: '发布章节', milestone: 'chapters_published', deliverable: { summary: '章节发布', checks: [{ kind: 'file', target: 'workspace/ch1.json' }] } }] } }],
        },
      },
    ]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('run');
    if (outcome.kind === 'run') {
      expect(outcome.dag.nodes[0]?.milestone).toBe('chapters_published');
    }
  });

  it('returns kind=empty when designer neither commits nor reports', async () => {
    const { store, memory } = setup();
    const llm = createFakeLLM([{ match: () => true, reply: { content: 'thinking but no action' } }]);
    const outcome = await runDesigner({ llm, logger: silentLogger(), store, memory, workDir: root, burstId: 'b1' });
    expect(outcome.kind).toBe('empty');
  });
});
