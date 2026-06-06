import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InnerBrainRegistry } from './inner-brain-registry.js';
import { PushLoop } from './push-loop.js';

describe('push-loop BLOCK', () => {
  let root: string;
  let registry: InnerBrainRegistry;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-loop-'));
    registry = new InnerBrainRegistry(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not postMessage on BLOCK events', async () => {
    const workDir = path.join(root, 'ws');
    const outputDir = path.join(workDir, '.run', 'pi-mono');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, 'output'),
      JSON.stringify({ type: 'BLOCK', message: 'need input', question: 'cookie?', ts: new Date().toISOString() }) + '\n',
      'utf8',
    );

    registry.register({
      instanceId: 'ib-pl-1',
      workspaceId: 'task-ib-pl-1',
      workDir,
      goal: 'test',
      originUser: 'human:u',
      originThread: 'thread:lab',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });

    const postMessage = vi.fn().mockResolvedValue(undefined);
    const loop = new PushLoop({
      registry,
      imClient: { postMessage } as never,
      agentSid: 'agent:test',
      pollMs: 50_000,
    });
    loop.start();

    await new Promise((r) => setTimeout(r, 50));
    loop.stop();

    expect(postMessage).not.toHaveBeenCalled();
    expect(registry.get('ib-pl-1')?.status).toBe('RUNNING');
  });
});
