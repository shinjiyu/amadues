import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

import { addPending } from '../openkuroneko/pendings/index.js';
import {
  POST_COMPLETE_REASON,
  buildBrainAsyncSnapshot,
  isBrainAwaitingAsync,
} from './brain-async-snapshot.js';

describe('brain-async-snapshot', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function mkWorkDir(): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-async-'));
    fs.mkdirSync(path.join(tmp, '.brain'), { recursive: true });
    return tmp;
  }

  it('timer pending → is_async_waiting, next_wake_at set', () => {
    const workDir = mkWorkDir();
    const brainDir = path.join(workDir, '.brain');
    addPending(brainDir, {
      kind: 'timer',
      spec: { execute_at: '2026-05-17T10:00:00.000Z' },
      source: 'tool:wait_timer(test)',
    });
    fs.writeFileSync(
      path.join(brainDir, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: '等定时' }),
      'utf8',
    );
    const snap = buildBrainAsyncSnapshot(workDir);
    expect(snap.is_async_waiting).toBe(true);
    expect(snap.is_post_complete).toBe(false);
    expect(snap.next_wake_at).toBe('2026-05-17T10:00:00.000Z');
    expect(isBrainAwaitingAsync(workDir)).toBe(true);
  });

  it('all-complete ask_user only → post_complete, not async waiting', () => {
    const workDir = mkWorkDir();
    const brainDir = path.join(workDir, '.brain');
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: POST_COMPLETE_REASON },
      source: 'all-complete',
    });
    fs.writeFileSync(
      path.join(brainDir, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: POST_COMPLETE_REASON }),
      'utf8',
    );
    const snap = buildBrainAsyncSnapshot(workDir);
    expect(snap.is_post_complete).toBe(true);
    expect(snap.is_async_waiting).toBe(false);
    expect(isBrainAwaitingAsync(workDir)).toBe(false);
  });
});
