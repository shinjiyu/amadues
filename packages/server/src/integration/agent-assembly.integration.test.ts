/**
 * F 装配烟雾：不启 HTTP / 真实 LLM，串联 KPI 注册表 → burst 退出 → 完成通知。
 */
import { afterEach, describe, expect, it } from 'vitest';

import path from 'node:path';
import { ChatAssetStore } from '@utlra/chat-ir';

import {
  createAgentStackFixture,
  createNoopEngine,
  type AgentStackFixture,
} from '../testing/index.js';
import { notifyInnerBrainTaskComplete } from '../outer/completion-notify.js';
import { buildKpiBurstLinks } from '../outer/kpi-progress.js';
import { sweepKpiCompletions } from '../outer/kpi-completion-judge.js';

describe('integration: agent assembly smoke', () => {
  let fx: AgentStackFixture;

  afterEach(() => {
    fx?.cleanup();
  });

  it('KPI → burst → registry → IM 完成通知（主路径）', async () => {
    fx = createAgentStackFixture();
    const kpiId = fx.createKpi('装配烟雾：文档交付');
    const { instanceId, workDir, task } = fx.simulateBurstExit(kpiId, {
      goal: '写一页摘要',
      deliverables: ['summary.md'],
      postComplete: true,
      verdict: 'success',
    });

    expect(fx.innerBrainRegistry.get(instanceId)?.status).toBe('DONE');

    sweepKpiCompletions(fx.kpiRegistry, fx.innerBrainRegistry);
    expect(fx.kpiRegistry.get(kpiId)?.status).toBe('achieved');

    const k = fx.kpiRegistry.get(kpiId)!;
    expect(buildKpiBurstLinks(k, fx.innerBrainRegistry).length).toBeGreaterThan(0);

    const assetStore = new ChatAssetStore(path.join(fx.dataRoot, 'uploads'));
    await expect(
      notifyInnerBrainTaskComplete(
        {
          imClient: fx.im,
          agentSid: 'agent:assembly',
          assetStore,
          getEngine: () => createNoopEngine(),
        },
        {
          instanceId,
          workspaceId: task.workspaceId,
          workDir,
          originThread: 'thread:assembly',
        },
      ),
    ).resolves.toBeUndefined();

    expect(fx.im.messagesMatching(/任务完成|产出/, 'thread:assembly').length).toBeGreaterThan(0);
  });
});
