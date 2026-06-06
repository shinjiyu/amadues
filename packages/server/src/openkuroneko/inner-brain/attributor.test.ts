import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import type { Logger } from '../logger/index.js';
import { runDyflowAttributor } from './attributor.js';
import { createMemoryStore } from './memory-store.js';
import type { RunContext } from './run-context-store.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

describe('runDyflowAttributor', () => {
  let root = '';
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('records facts from run context via record_fact tool', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-'));
    const memory = createMemoryStore(root);
    memory.patch('goal', 'explore fanqie api');

    const ctx: RunContext = {
      burstId: 'b1',
      designedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      ok: false,
      failedAt: 'n1',
      nodes: [{
        nodeInstId: 'n1',
        ref: 'preset/base',
        ok: false,
        status: 'capped',
        failureSummary: 'safety cap',
        rawTail: 'web_search Playwright returned category list; curl empty',
        entries: [{ toolName: 'web_search', args: {}, result: { ok: true, output: 'categories' } }],
      }],
      results: [],
    };

    const llm = createFakeLLM([
      {
        match: ({ systemPrompt }) => systemPrompt.includes('Mandatory Attributor'),
        reply: {
          content: '',
          toolCalls: [{
            id: 'f1',
            name: 'record_fact',
            args: { fact: '[事实] 番茄分类 API 须用 Playwright fetch，curl 返回空 body' },
          }],
        },
      },
      {
        match: ({ systemPrompt }) => systemPrompt.includes('Mandatory Attributor'),
        reply: { content: '归因完成' },
      },
    ], { consumeOnMatch: true });

    const res = await runDyflowAttributor(ctx, { llm, logger: silentLogger(), memory });
    expect(res.ok).toBe(true);
    expect(res.toolCalls).toBe(1);
    expect(memory.read().facts.some(f => f.includes('Playwright'))).toBe(true);
  });
});
