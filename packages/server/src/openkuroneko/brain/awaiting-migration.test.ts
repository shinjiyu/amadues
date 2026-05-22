/**
 * BrainFS AWAITING 集成单测
 *
 * 验证：
 *   1. 新加 ControllerMode AWAITING 可以正常 read/write
 *   2. BrainFS 的 pendings 代理（read/add/resolve/markConsumed/expire/timers）一致工作
 */

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BrainFS } from './brain-fs.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainfs-await-'));
}

describe('BrainFS AWAITING integration', () => {
  let dir: string;
  let brain: BrainFS;

  beforeEach(() => {
    dir = tmpDir();
    brain = new BrainFS(dir);
  });

  it('writeState AWAITING round-trips', () => {
    brain.writeState({
      mode: 'AWAITING',
      replanCount: 0,
      replanReason: null,
      blockedReason: null,
      awaitingReason: '等用户回复',
    });
    const s = brain.readState();
    expect(s.mode).toBe('AWAITING');
    expect(s.awaitingReason).toBe('等用户回复');
  });

  it('addPending then listActivePendings yields the item', () => {
    const item = brain.addPending({
      kind: 'ask_user',
      spec: { prompt: '需要 token' },
    });
    expect(item.kind).toBe('ask_user');
    expect(brain.listActivePendings().length).toBe(1);
  });

  it('resolvePending flips status and shows up in unconsumed-resolved', () => {
    const item = brain.addPending({ kind: 'ask_user', spec: { prompt: 'q' } });
    brain.resolvePending(item.id, { result: { reply: 'ok' } });
    expect(brain.listActivePendings().length).toBe(0);
    expect(brain.listUnconsumedResolvedPendings().length).toBe(1);
    brain.markPendingsConsumed([item.id]);
    expect(brain.listUnconsumedResolvedPendings().length).toBe(0);
  });

  it('resolveDueTimers fires past timers', () => {
    const past = new Date(Date.now() - 5000).toISOString();
    const item = brain.addPending({ kind: 'timer', spec: { execute_at: past } });
    const fired = brain.resolveDueTimers();
    expect(fired).toEqual([item.id]);
  });

  it('expireOverduePendings handles deadlines', () => {
    const past = new Date(Date.now() - 5000).toISOString();
    brain.addPending({
      kind: 'ask_user',
      spec: { prompt: 'q' },
      deadline: past,
      on_timeout: { action: 'cancel' },
    });
    const expired = brain.expireOverduePendings();
    expect(expired.length).toBe(1);
    expect(brain.readPendings()[0]?.status).toBe('cancelled');
  });

  it('git commit hook works through BrainFS', async () => {
    if (!brain.git.enabled) return;
    brain.writeGoal('g1');
    const oid = await brain.commit('first', { mode: 'DECOMPOSE' });
    expect(oid).toBeTruthy();
  });
});
