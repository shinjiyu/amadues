/**
 * ADL component: brainFs — goal / milestones / controller state
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BrainFS } from './brain-fs.js';

describe('component: brainFs', () => {
  let workDir = '';

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('writeGoal + parseMilestones（主路径）', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainfs-'));
    const brain = new BrainFS(workDir);
    brain.writeGoal('战略目标');
    brain.writeMilestones('[M1] [Active] 步骤一 — 描述\n');
    expect(brain.readGoal()).toContain('战略目标');
    const ms = brain.parseMilestones();
    expect(ms[0]?.id).toBe('M1');
    expect(ms[0]?.status).toBe('Active');
  });

  it('readState / writeState 默认 DECOMPOSE', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainfs-'));
    const brain = new BrainFS(workDir);
    expect(brain.readState().mode).toBe('DECOMPOSE');
    brain.writeState({ mode: 'EXECUTE', replanCount: 0, replanReason: null, blockedReason: null });
    expect(brain.readState().mode).toBe('EXECUTE');
  });
});
