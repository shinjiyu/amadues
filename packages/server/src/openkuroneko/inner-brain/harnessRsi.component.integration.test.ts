import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import { createToolRegistry } from '../tools/index.js';
import type { Logger } from '../logger/index.js';
import { createDyflowController } from './controller.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
import { requestHarnessRestart } from './harness-restart.js';
import { writeRunContext } from './run-context-store.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

describe('harness RSI P2 + controller', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rsi-c-'));
    fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
    fs.writeFileSync(path.join(root, '.brain', 'goal.md'), 'goal', 'utf8');
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('tick consumes restart request and re-enters DESIGN without spawning a process', async () => {
    fs.writeFileSync(
      path.join(root, '.brain', 'dyflow-state.json'),
      JSON.stringify({ mode: 'RUN', burstId: 'b1', designStreak: 2, updatedAt: new Date().toISOString() }),
      'utf8',
    );
    const store = createHarnessSpecStore(root);
    store.put({ id: 'hs-a', refs: {}, status: 'gated_ok' });
    createHarnessPointer(root, store).upgrade('hs-a');
    requestHarnessRestart(root, { store });

    const controller = createDyflowController(
      { workDir: root, workspaceId: 'ws', burstId: 'b1' },
      { llm: createFakeLLM([]), toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );
    const t = await controller.tick();
    expect(t.hadWork).toBe(true);
    const state = JSON.parse(
      fs.readFileSync(path.join(root, '.brain', 'dyflow-state.json'), 'utf8'),
    ) as { mode: string; reason?: string; designStreak?: number };
    expect(state.mode).toBe('DESIGN');
    expect(state.reason).toMatch(/restart-with-H:hs-a/);
    expect(state.designStreak).toBe(0);
    expect(fs.existsSync(path.join(root, '.brain', 'harness', 'restart-requested.json'))).toBe(false);
  });

  it('ATTRIBUTE failed RUN: revise→gate→upgrade→restart-with-H', async () => {
    const store = createHarnessSpecStore(root);
    store.put({
      id: 'hs-old',
      refs: { localNodeIds: ['local/old'] },
      status: 'gated_ok',
    });
    createHarnessPointer(root, store).upgrade('hs-old');

    writeRunContext(root, {
      burstId: 'b1',
      designedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ok: false,
      failedAt: 'n1',
      nodes: [{ nodeInstId: 'n1', ref: 'local/new', ok: false, entries: [] }],
      results: [],
    });
    fs.writeFileSync(
      path.join(root, '.brain', 'dyflow-state.json'),
      JSON.stringify({
        mode: 'ATTRIBUTE',
        burstId: 'b1',
        designStreak: 0,
        harnessRsiRound: 0,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const llm = createFakeLLM([
      {
        label: 'attributor',
        match: ({ systemPrompt }) => systemPrompt.includes('Mandatory Attributor'),
        reply: { content: 'noted failure' },
      },
    ]);
    const controller = createDyflowController(
      { workDir: root, workspaceId: 'ws', burstId: 'b1' },
      { llm, toolRegistry: createToolRegistry([]), logger: silentLogger() },
    );
    await controller.tick();

    const active = createHarnessPointer(root, store).readActive();
    expect(active?.harnessId).not.toBe('hs-old');
    expect(fs.existsSync(path.join(root, '.brain', 'harness', 'restart-requested.json'))).toBe(true);
    const state = JSON.parse(
      fs.readFileSync(path.join(root, '.brain', 'dyflow-state.json'), 'utf8'),
    ) as { mode: string; reason?: string; harnessRsiRound?: number };
    expect(state.mode).toBe('DESIGN');
    expect(state.reason).toMatch(/harness-rsi:/);
    expect(state.harnessRsiRound).toBe(1);

    await controller.tick();
    const after = JSON.parse(
      fs.readFileSync(path.join(root, '.brain', 'dyflow-state.json'), 'utf8'),
    ) as { reason?: string };
    expect(after.reason).toMatch(/restart-with-H:/);
  });
});
