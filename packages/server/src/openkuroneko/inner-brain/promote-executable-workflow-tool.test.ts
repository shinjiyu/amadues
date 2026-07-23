import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeLLM } from '../../testing/fake-llm.js';
import type { Logger } from '../logger/index.js';
import { runDyflowAttributor } from './attributor.js';
import { createMemoryStore } from './memory-store.js';
import { createLocalNodeStore } from './local-node-store.js';
import type { RunContext } from './run-context-store.js';
import { ExecutableWorkflowStore } from '../../outer/executable-workflow-store.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

describe('Attributor promote_executable_workflow', () => {
  let root = '';

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('RUN 成功时可 promote frozen_dag 到 DATA_ROOT/workflows', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-ew-'));
    const workDir = path.join(root, 'workspaces', 'task-ib-test');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.brain', 'local_dag.json'),
      JSON.stringify({ nodes: [{ id: 'n1', ref: 'preset/base' }], entry: 'n1' }),
      'utf8',
    );

    const memory = createMemoryStore(workDir);
    memory.patch('goal', 'publish chapter');

    const ctx: RunContext = {
      burstId: 'b1',
      designedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
      ok: true,
      nodes: [
        {
          nodeInstId: 'n1',
          ref: 'preset/base',
          ok: true,
          status: 'done',
          instruction: 'publish',
          entries: [],
        },
      ],
      results: [],
    };

    const llm = createFakeLLM(
      [
        {
          match: ({ systemPrompt }) => systemPrompt.includes('Mandatory Attributor'),
          reply: {
            content: '',
            toolCalls: [
              {
                id: 'p1',
                name: 'promote_executable_workflow',
                args: {
                  workflow_id: 'ew-publish',
                  title: 'Publish path',
                  from: 'auto',
                },
              },
            ],
          },
        },
        {
          match: ({ systemPrompt }) => systemPrompt.includes('Mandatory Attributor'),
          reply: { content: '已晋升' },
        },
      ],
      { consumeOnMatch: true },
    );

    const res = await runDyflowAttributor(ctx, {
      llm,
      logger: silentLogger(),
      memory,
      workDir,
      localStore: createLocalNodeStore(workDir),
      kpiId: 'kpi-novel',
    });
    expect(res.ok).toBe(true);
    expect(res.toolCalls).toBe(1);

    const store = new ExecutableWorkflowStore({ dataRoot: root });
    const wf = store.getLatest('ew-publish');
    expect(wf?.kind).toBe('frozen_dag');
    expect(wf?.tags).toContain('kpi:kpi-novel');
  });
});
