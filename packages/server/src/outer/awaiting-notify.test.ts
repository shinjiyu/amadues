import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addPending } from '../openkuroneko/pendings/index.js';
import { notifyInnerBrainAwaitingHuman } from './awaiting-notify.js';

describe('awaiting-notify', () => {
  let root: string;
  let workDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'await-notify-'));
    workDir = path.join(root, 'ws');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sends once and dedups second call', async () => {
    const brainDir = path.join(workDir, '.brain');
    addPending(brainDir, { kind: 'ask_user', spec: { prompt: 'paste cookie' } });

    const postMessage = vi.fn().mockResolvedValue(undefined);
    const deps = { imClient: { postMessage } as never, agentSid: 'agent:test' };

    const record = {
      instanceId: 'ib-1',
      workDir,
      originThread: 'thread:lab',
    };

    expect(await notifyInnerBrainAwaitingHuman(deps, record)).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]![1].text).toContain('⏸ 内脑任务等待您的输入');

    expect(await notifyInnerBrainAwaitingHuman(deps, record)).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('skips when no ask_user pending', async () => {
    const postMessage = vi.fn();
    const sent = await notifyInnerBrainAwaitingHuman(
      { imClient: { postMessage } as never, agentSid: 'agent:test' },
      { instanceId: 'ib-2', workDir, originThread: 'thread:x' },
    );
    expect(sent).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
