/**
 * ADL component: executor — 里程碑上下文组装（不发起 LLM）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BrainFS } from '../brain/brain-fs.js';
import { EXECUTOR_SYSTEM } from './executor.js';

describe('component: executor', () => {
  let workDir = '';

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('EXECUTOR_SYSTEM 定义反应执行器（主路径锚点）', () => {
    expect(EXECUTOR_SYSTEM).toContain('反应执行器');
  });

  it('Active 里程碑可被 brain 解析供 executor 注入', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-'));
    const brain = new BrainFS(workDir);
    brain.writeMilestones('[M1] [Active] 执行步骤 — 详细说明\n');
    const active = brain.parseMilestones().find((m) => m.status === 'Active');
    expect(active?.title).toBe('执行步骤');
  });
});
