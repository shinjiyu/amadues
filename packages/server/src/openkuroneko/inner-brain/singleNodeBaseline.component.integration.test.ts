import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import type { Logger } from '../logger/index.js';
import { createToolRegistry } from '../tools/index.js';
import { createMemoryStore } from './memory-store.js';
import {
  SINGLE_NODE_BASELINE_RESULT_FILE,
  runSingleNodeBaseline,
} from './single-node-baseline.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function toolNames(tools: object[] | undefined): string[] {
  return (tools ?? [])
    .map(t => (t as { function?: { name?: string } }).function?.name)
    .filter((n): n is string => typeof n === 'string');
}

describe('runSingleNodeBaseline (integration)', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'single-node-'));
    fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(root, '.brain', 'goal.md'), 'fix the renderer so the bug moves', 'utf8');
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('hands the whole goal to one preset/base node and never calls the Designer', async () => {
    const llm = createFakeLLM([
      {
        label: 'designer',
        match: ({ systemPrompt }) => systemPrompt.includes('Designer') && !systemPrompt.includes('baseNode 执行器'),
        reply: { content: 'designer must not run' },
      },
      {
        label: 'base-run',
        match: ({ systemPrompt }) => systemPrompt.includes('baseNode 执行器'),
        reply: { content: 'renderer fixed; bug position now updates every frame' },
      },
    ]);

    const result = await runSingleNodeBaseline(
      { workDir: root, burstId: 'b-single' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe('ok');
    expect(llm.calls.map(c => c.matchedLabel)).toEqual(['base-run']);
    const firstUser = llm.calls[0]!.messages.find(m => m.role === 'user');
    expect(String(firstUser?.content)).toContain('fix the renderer so the bug moves');

    const mem = createMemoryStore(root).read();
    expect(mem.goal).toBe('fix the renderer so the bug moves');
    expect(mem.node_results['single']?.ok).toBe(true);

    expect(fs.existsSync(path.join(root, '.brain', 'dyflow-state.json'))).toBe(false);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, SINGLE_NODE_BASELINE_RESULT_FILE), 'utf8'),
    ) as { ok: boolean; status: string; burstId: string };
    expect(persisted).toMatchObject({ ok: true, status: 'ok', burstId: 'b-single' });
  });

  it('offers the node the same augmented tools as the DyFlow Runner (memory tools included)', async () => {
    const llm = createFakeLLM([
      {
        label: 'base-run',
        match: ({ systemPrompt }) => systemPrompt.includes('baseNode 执行器'),
        reply: { content: 'done' },
      },
    ]);
    await runSingleNodeBaseline(
      { workDir: root, burstId: 'b-tools' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );
    expect(toolNames(llm.calls[0]!.tools)).toContain('record_fact');
  });

  it('stops after one terminal failure without retrying', async () => {
    const llm = createFakeLLM([
      {
        label: 'base-fail',
        match: ({ systemPrompt }) => systemPrompt.includes('baseNode 执行器'),
        reply: { content: 'CANNOT_CONTINUE: renderer source is missing' },
      },
    ]);

    const result = await runSingleNodeBaseline(
      { workDir: root, burstId: 'b-fail' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.failureSummary).toContain('renderer source is missing');
    expect(llm.calls).toHaveLength(1);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(root, SINGLE_NODE_BASELINE_RESULT_FILE), 'utf8'),
    ) as { ok: boolean };
    expect(persisted.ok).toBe(false);
  });

  it('refuses to run without a goal', async () => {
    fs.rmSync(path.join(root, '.brain', 'goal.md'));
    const llm = createFakeLLM([]);
    const result = await runSingleNodeBaseline(
      { workDir: root, burstId: 'b-nogoal' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('no_goal');
    expect(llm.calls).toHaveLength(0);
  });
});
