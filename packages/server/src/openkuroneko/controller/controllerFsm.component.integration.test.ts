/**
 * ADL component: controllerFsm — BrainFS 状态机读写（file-as-state）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BrainFS } from '../brain/brain-fs.js';

describe('component: controllerFsm', () => {
  let workDir = '';

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('初始 mode=DECOMPOSE（主路径）', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-'));
    const brain = new BrainFS(workDir);
    expect(brain.readState().mode).toBe('DECOMPOSE');
    expect(brain.readState().replanCount).toBe(0);
  });

  it('DECOMPOSE → EXECUTE → AWAITING 状态迁移', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsm-'));
    const brain = new BrainFS(workDir);
    brain.writeState({
      mode: 'EXECUTE',
      replanCount: 0,
      replanReason: null,
      blockedReason: null,
    });
    brain.writeState({
      mode: 'AWAITING',
      replanCount: 0,
      replanReason: null,
      blockedReason: null,
      awaitingReason: '等待用户',
    });
    expect(brain.readState().mode).toBe('AWAITING');
    expect(brain.readState().awaitingReason).toContain('等待');
  });
});
