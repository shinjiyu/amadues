import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import { createToolRegistry } from '../tools/index.js';
import type { Logger } from '../logger/index.js';
import { createDyflowController } from './controller.js';
import { createMemoryStore } from './memory-store.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

describe('createDyflowController (integration)', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dyflow-ctrl-'));
    fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(root, '.brain', 'goal.md'), 'collect and summarize weather', 'utf8');
    fs.writeFileSync(path.join(root, 'weather.txt'), 'sunny weather summary for acceptance', 'utf8');
  });
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('seeds presets and seeds goal from goal.md on creation', () => {
    createDyflowController({ workDir: root, burstId: 'b1' }, {
      llm: createFakeLLM([]), toolRegistry: createToolRegistry([]), logger: silentLogger(),
    });
    expect(fs.existsSync(path.join(root, '.brain', 'local_nodes', 'preset', 'base.json'))).toBe(true);
    expect(createMemoryStore(root).read().goal).toBe('collect and summarize weather');
  });

  it('runs DESIGN -> RUN -> ATTRIBUTE -> DESIGN(done) across ticks', async () => {
    const completes: string[] = [];
    const node = {
      id: 'n1',
      ref: 'preset/base',
      instruction: 'fetch weather',
      deliverable: { summary: 'weather file', checks: [{ kind: 'file', target: 'weather.txt' }] },
    };
    const llm = createFakeLLM([
      {
        label: 'design-commit',
        match: ({ systemPrompt, messages }) =>
          systemPrompt.includes('Designer') && lastUser(messages).includes('请规划本轮'),
        reply: { content: '', toolCalls: [{ id: 'd1', name: 'commit_local_dag', args: { nodes: [node] } }] },
      },
      {
        label: 'design-done',
        match: ({ systemPrompt, messages }) =>
          systemPrompt.includes('Designer') && lastUser(messages).includes('(preset/base): ok'),
        reply: { content: '', toolCalls: [{ id: 'd2', name: 'report_done', args: { reason: 'goal achieved' } }] },
      },
      {
        label: 'attributor',
        match: ({ systemPrompt }) => systemPrompt.includes('Mandatory Attributor'),
        reply: { content: 'distilled ok run' },
      },
      {
        label: 'base-run',
        match: ({ systemPrompt }) => systemPrompt.includes('baseNode 执行器'),
        reply: { content: 'weather fetched and summarized with enough detail for acceptance' },
      },
    ], { consumeOnMatch: true });

    const controller = createDyflowController(
      { workDir: root, burstId: 'b1' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger(), onComplete: r => { completes.push(r); } },
    );

    const t1 = await controller.tick();
    expect(t1.hadWork).toBe(true);
    expect(readMode(root)).toBe('RUN');

    const t2 = await controller.tick();
    expect(t2.hadWork).toBe(true);
    expect(readMode(root)).toBe('ATTRIBUTE');
    expect(createMemoryStore(root).read().node_results['n1']?.ok).toBe(true);
    expect(fs.existsSync(path.join(root, '.brain', 'run-context.json'))).toBe(true);

    const t3 = await controller.tick();
    expect(t3.hadWork).toBe(true);
    expect(readMode(root)).toBe('DESIGN');
    expect(fs.existsSync(path.join(root, '.brain', 'run-context.json'))).toBe(false);

    const t4 = await controller.tick();
    expect(readMode(root)).toBe('DONE');
    expect(completes).toEqual(['goal achieved']);

    const t5 = await controller.tick();
    expect(t5.hadWork).toBe(false);
  });

  it('distills constraints after failed RUN via ATTRIBUTE before next DESIGN', async () => {
    const failNode = {
      id: 'n1',
      ref: 'preset/base',
      instruction: 'will fail',
      deliverable: { summary: 'out', checks: [{ kind: 'file', target: 'x.txt' }] },
    };
    const llm = createFakeLLM([
      {
        label: 'design-commit',
        match: ({ systemPrompt, messages }) =>
          systemPrompt.includes('Designer') && lastUser(messages).includes('请规划本轮'),
        reply: {
          content: '',
          toolCalls: [{ id: 'd1', name: 'commit_local_dag', args: { nodes: [failNode] } }],
        },
      },
      {
        label: 'attributor',
        match: ({ systemPrompt }) => systemPrompt.includes('Mandatory Attributor'),
        reply: { content: 'noted failure' },
      },
      {
        label: 'base-fail',
        match: ({ systemPrompt, messages }) =>
          systemPrompt.includes('baseNode 执行器') &&
          lastUser(messages).includes('will fail'),
        reply: { content: 'CANNOT_CONTINUE: API path wrong permanently' },
      },
    ], { consumeOnMatch: true });
    const controller = createDyflowController(
      { workDir: root, burstId: 'b1' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );
    await controller.tick();
    await controller.tick();
    await controller.tick();
    const mem = createMemoryStore(root).read();
    expect(mem.constraints.some(c => c.startsWith('[run-failure]'))).toBe(true);
    expect(mem.node_results['n1']?.ok).toBe(false);
    expect(readMode(root)).toBe('DESIGN');
  });

  it('gives up after repeated empty DESIGN ticks', async () => {
    const llm = createFakeLLM([{ match: () => true, reply: { content: 'no action' } }]);
    const controller = createDyflowController(
      { workDir: root, burstId: 'b1' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );
    await controller.tick();
    await controller.tick();
    await controller.tick();
    expect(readMode(root)).toBe('DONE');
    expect(readState(root).reason).toContain('空转');
  });
});

function lastUser(messages: { role: string; content: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

function readState(root: string): { mode: string; reason?: string } {
  return JSON.parse(fs.readFileSync(path.join(root, '.brain', 'dyflow-state.json'), 'utf8'));
}
function readMode(root: string): string {
  return readState(root).mode;
}
