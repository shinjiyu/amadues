/**
 * 集成：完成通知应从工作区重建「结果优先」正文（非满屏里程碑过程）
 */
import { afterEach, describe, expect, it } from 'vitest';

import path from 'node:path';
import { ChatAssetStore } from '@utlra/chat-ir';

import { createAgentStackFixture, type AgentStackFixture } from '../testing/index.js';
import { notifyInnerBrainTaskComplete } from '../outer/completion-notify.js';
import { createNoopEngine } from '../testing/agent-stack-fixture.js';

describe('integration: completion notify', () => {
  let fx: AgentStackFixture;

  afterEach(() => {
    fx?.cleanup();
  });

  it('postMessage 含核心结论与产出，不含「输入范围」过程字段', async () => {
    fx = createAgentStackFixture();
    const kpiId = fx.createKpi('评估任务');
    const { instanceId, workDir, task } = fx.simulateBurstExit(kpiId, {
      goal: '评估贡献者',
      deliverables: ['evaluation.md'],
      postComplete: true,
      reflexion: { verdict: 'success' },
    });

    const assetStore = new ChatAssetStore(path.join(fx.dataRoot, 'uploads'));

    await notifyInnerBrainTaskComplete(
      {
        imClient: fx.im,
        agentSid: 'agent:test',
        assetStore,
        getEngine: () => createNoopEngine(),
      },
      {
        instanceId,
        workspaceId: task.workspaceId,
        workDir,
        originThread: 'thread:test',
      },
    );

    const texts = fx.im.messagesMatching(/✅|## 结果/, 'thread:test');
    expect(texts.length).toBeGreaterThan(0);
    const body = texts[0]!.body.text ?? '';
    expect(body).toMatch(/## 结果|## 产出文件|任务完成/);
    expect(body).not.toContain('## 里程碑进度');
    expect(body).not.toContain('## 自评');
    expect(body).not.toContain('输入范围');
    expect(body).not.toContain('禁止或尽量减少');
  });
});
