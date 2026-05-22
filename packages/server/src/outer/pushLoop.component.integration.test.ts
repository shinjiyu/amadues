/**
 * ADL component: pushLoop — 增量读取 pi-mono output
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InnerBrainRegistry } from './inner-brain-registry.js';
import { PushLoop } from './push-loop.js';
import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';

describe('component: pushLoop', () => {
  let root: TestDataRoot;
  let workDir = '';

  afterEach(() => {
    vi.restoreAllMocks();
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    root?.cleanup();
  });

  it('新 BLOCK 行 → postMessage + AWAITING（主路径）', async () => {
    root = createTestDataRoot('push-');
    const reg = new InnerBrainRegistry(root.dataRoot);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-ws-'));
    const runDir = path.join(workDir, '.run', 'pi-mono');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'output'),
      JSON.stringify({
        type: 'BLOCK',
        message: '需要 API key',
        question: '请提供 key',
      }) + '\n',
      'utf8',
    );

    const instanceId = reg.generateInstanceId();
    reg.register({
      instanceId,
      workspaceId: 'ws-push',
      workDir,
      goal: 'g',
      originUser: 'u1',
      originThread: 'thread:push',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });

    const posts: Array<{ threadId: string; body: string }> = [];
    const im = {
      postMessage: vi.fn(async (threadId: string, body: { text: string }) => {
        posts.push({ threadId, body: body.text });
      }),
    };

    const loop = new PushLoop({
      registry: reg,
      imClient: im as never,
      agentSid: 'agent:test',
      pollMs: 60_000,
    });
    await (loop as unknown as { tick: () => Promise<void> }).tick();

    expect(posts.some((p) => p.threadId === 'thread:push' && p.body.includes('阻塞'))).toBe(true);
    expect(reg.get(instanceId)?.status).toBe('AWAITING');
  });
});
