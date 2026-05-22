/**
 * ADL component: archiveStore — archive + retrieve（KPI 优先）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFilesystemStore } from './fs-store.js';
import { BrainFS } from '../brain/brain-fs.js';

describe('component: archiveStore', () => {
  let kbDir = '';
  let workspaceRoot = '';

  beforeEach(() => {
    kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-kb-'));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-ws-'));
  });

  afterEach(() => {
    for (const d of [kbDir, workspaceRoot]) {
      if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('同 kpiId 会话在 retrieve 中优先（主路径）', async () => {
    const store = createFilesystemStore(kbDir);
    const kpiId = 'kpi-arch-1';

    async function archiveOne(
      agentId: string,
      goalText: string,
      kid?: string,
    ): Promise<void> {
      const wsId = `ws-${agentId}-${Date.now()}`;
      const workDir = path.join(workspaceRoot, wsId);
      fs.mkdirSync(workDir, { recursive: true });
      const brain = new BrainFS(workDir);
      brain.writeGoal(goalText);
      brain.appendConstraint(`[红线] ${agentId}`);
      brain.appendKnowledge(`[事实] ${goalText}`);
      await store.archive({
        brain,
        agentId,
        workDir,
        trigger: kid ? 'BLOCK' : 'COMPLETE',
        triggerReason: 'done',
        goalText,
        ...(kid ? { kpiId: kid } : {}),
      });
    }

    await archiveOne('a-off', '与狗有关的训练任务');
    await archiveOne('a-kpi', '与狗有关的训练任务', kpiId);

    const sessions = await store.retrieve('抓取股票数据并生成报告', { kpiId });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]?.meta.kpiId).toBe(kpiId);
  });
});
