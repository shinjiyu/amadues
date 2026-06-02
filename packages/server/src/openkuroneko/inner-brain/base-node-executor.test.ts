import { describe, expect, it } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import { createToolRegistry } from '../tools/index.js';
import type { Tool } from '../tools/index.js';
import type { Logger } from '../logger/index.js';
import { runBaseNode, renderTemplate, resolveParams, __internal } from './base-node-executor.js';
import type { InnerMemory, LocalNode, NodeInst } from './types.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function baseNode(overrides: Partial<LocalNode> = {}): LocalNode {
  return {
    id: 'preset/base',
    version: '1.0.0',
    displayName: 'Base',
    description: 'do the job',
    tags: [],
    interface: { inputs: [], outputs: [{ key: 'result', type: 'string' }] },
    body: { kind: 'executor', promptTemplate: 'you are base', tools: ['*'] },
    metadata: { origin: 'preset', createdAt: '', updatedAt: '' },
    ...overrides,
  };
}

function emptyMemory(): InnerMemory {
  return { constraints: [], facts: [], node_results: {}, last_failure: null };
}

const inst: NodeInst = { id: 'n1', ref: 'preset/base', instruction: 'fetch the data' };

describe('renderTemplate', () => {
  it('substitutes params and memory placeholders', () => {
    const out = renderTemplate('go ${{ params.url }} for ${{ memory.goal }}', {
      params: { url: 'http://x' },
      memory: { ...emptyMemory(), goal: 'win' },
    });
    expect(out).toBe('go http://x for win');
  });
  it('blanks unknown placeholders', () => {
    expect(renderTemplate('a ${{ params.nope }} b', { params: {}, memory: emptyMemory() })).toBe('a  b');
  });
});

describe('resolveParams precedence', () => {
  it('inst.params overrides defaults and workDir', () => {
    const node = baseNode({
      body: { kind: 'executor', promptTemplate: 'x', tools: ['*'], defaultParams: { a: 1, b: 2 } },
      metadata: { origin: 'imported', workDir: '/w', createdAt: '', updatedAt: '' },
    });
    const p = resolveParams(node, { id: 'n', ref: 'x', params: { b: 99 } });
    expect(p).toMatchObject({ a: 1, b: 99, workDir: '/w' });
  });
});

describe('roundHadToolProgress', () => {
  it('true when any tool ok', () => {
    expect(__internal.roundHadToolProgress([false, true])).toBe(true);
  });
  it('false when all failed', () => {
    expect(__internal.roundHadToolProgress([false, false])).toBe(false);
  });
});

describe('detectTerminal', () => {
  it('detects CANNOT_CONTINUE', () => {
    expect(__internal.detectTerminal('blah\nCANNOT_CONTINUE: path missing').abort).toBe(true);
    expect(__internal.detectTerminal('CANNOT_CONTINUE: path missing').reason).toBe('path missing');
  });
  it('detects transient marker', () => {
    const t = __internal.detectTerminal('CANNOT_CONTINUE(transient): timeout');
    expect(t.transient).toBe(true);
  });
  it('no false positive', () => {
    expect(__internal.detectTerminal('all good, finished').abort).toBe(false);
  });
});

describe('runBaseNode', () => {
  it('injects runtime context into system prompt', async () => {
    let sawRuntime = false;
    const llm = createFakeLLM([
      {
        match: ({ systemPrompt }) => {
          sawRuntime =
            systemPrompt.includes('## 运行时环境') &&
            systemPrompt.includes('明文') &&
            systemPrompt.includes('workDir: /tmp/x');
          return true;
        },
        reply: { content: 'ok' },
      },
    ]);
    await runBaseNode(
      { node: baseNode(), inst, memory: emptyMemory(), workDir: '/tmp/x' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );
    expect(sawRuntime).toBe(true);
  });

  it('completes when LLM finishes without tool calls', async () => {
    const llm = createFakeLLM([{ label: 'done', match: 'fetch the data', reply: { content: 'fetched ok' } }]);
    const outcome = await runBaseNode(
      { node: baseNode(), inst, memory: emptyMemory(), workDir: '/tmp/x' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.outputs).toEqual({ result: 'fetched ok' });
  });

  it('runs a tool then finishes', async () => {
    let toolCalled = false;
    const probe: Tool = {
      name: 'probe',
      description: 'probe',
      async call() { toolCalled = true; return { ok: true, output: 'env ready' }; },
    };
    const llm = createFakeLLM([
      { label: 'call', match: ({ messages }) => messages.length === 1, reply: { content: '', toolCalls: [{ id: 't1', name: 'probe', args: {} }] } },
      { label: 'finish', match: () => true, reply: { content: 'done after probe' } },
    ]);
    const node = baseNode({ body: { kind: 'executor', promptTemplate: 'x', tools: ['probe'] } });
    const outcome = await runBaseNode(
      { node, inst, memory: emptyMemory(), workDir: '/tmp/x' },
      { llm, toolRegistry: createToolRegistry([probe]), logger: silentLogger() },
    );
    expect(toolCalled).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(outcome.executionLog).toHaveLength(1);
  });

  it('produces high-confidence terminal failure on CANNOT_CONTINUE', async () => {
    const llm = createFakeLLM([{ match: () => true, reply: { content: 'CANNOT_CONTINUE: login permanently failed' } }]);
    const outcome = await runBaseNode(
      { node: baseNode(), inst, memory: emptyMemory(), workDir: '/tmp/x' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.confidence).toBe('high');
    expect(outcome.failure?.summary).toContain('login permanently failed');
    expect(outcome.failure?.nodeInstId).toBe('n1');
  });

  it('fail-fast after consecutive tool rounds with no ok:true', async () => {
    const failTool: Tool = {
      name: 'fail_probe',
      description: 'always fails',
      async call() {
        return { ok: false, output: 'still broken' };
      },
    };
    const replies = Array.from({ length: 8 }, (_, i) => ({
      label: `round-${i}`,
      match: () => true,
      reply: {
        content: 'try again',
        toolCalls: [{ id: `t${i}`, name: 'fail_probe', args: {} }],
      },
    }));
    const llm = createFakeLLM(replies);
    const node = baseNode({ body: { kind: 'executor', promptTemplate: 'x', tools: ['fail_probe'] } });
    const outcome = await runBaseNode(
      { node, inst, memory: emptyMemory(), workDir: '/tmp/x' },
      { llm, toolRegistry: createToolRegistry([failTool]), logger: silentLogger() },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.failure?.transient).toBe(true);
    expect(outcome.failure?.summary).toMatch(/连续 \d+ 轮工具调用均无 ok:true 进展/);
    expect(outcome.executionLog.length).toBeGreaterThanOrEqual(5);
  });

  it('enforces tool allowlist', async () => {
    const blocked: Tool = { name: 'danger', description: 'x', async call() { return { ok: true, output: 'should not run' }; } };
    const llm = createFakeLLM([
      { match: ({ messages }) => messages.length === 1, reply: { content: '', toolCalls: [{ id: 't1', name: 'danger', args: {} }] } },
      { match: () => true, reply: { content: 'gave up calling blocked tool, done' } },
    ]);
    const node = baseNode({ body: { kind: 'executor', promptTemplate: 'x', tools: ['probe'] } });
    const outcome = await runBaseNode(
      { node, inst, memory: emptyMemory(), workDir: '/tmp/x' },
      { llm, toolRegistry: createToolRegistry([blocked]), logger: silentLogger() },
    );
    expect(outcome.executionLog[0]?.result.output).toBe('not allowed');
  });
});
