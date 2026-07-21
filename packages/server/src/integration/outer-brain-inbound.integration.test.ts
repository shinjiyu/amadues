/**
 * F 装配：OuterBrain.handleInbound（无 LLM → IM 降级回复）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOuterBrainFixture, type OuterBrainFixture } from '../testing/outer-brain-fixture.js';

const LLM_ENV_KEYS = [
  'ZHIPU_API_KEY',
  'KIMI_API_KEY',
  'LOCALMODULE_API_KEY',
  'UTLRA_INNER_LLM_PROVIDER',
] as const;

describe('integration: outer brain inbound assembly', () => {
  let fx: OuterBrainFixture;
  const envSnapshot: Partial<Record<(typeof LLM_ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const k of LLM_ENV_KEYS) {
      if (process.env[k] !== undefined) envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
    process.env['UTLRA_OUTER_JITTER_MIN_MS'] = '0';
    process.env['UTLRA_OUTER_JITTER_MAX_MS'] = '0';
    process.env['UTLRA_AGENT_IM_SID'] = 'agent:assembly-inbound';
    fx = createOuterBrainFixture('agent:assembly-inbound');
  });

  afterEach(() => {
    fx?.cleanup();
    for (const k of LLM_ENV_KEYS) {
      const v = envSnapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env['UTLRA_OUTER_JITTER_MIN_MS'];
    delete process.env['UTLRA_OUTER_JITTER_MAX_MS'];
    delete process.env['UTLRA_AGENT_IM_SID'];
  });

  it('DM 入站、无 LLM key → FakeIm 收到降级提示', async () => {
    const threadId = `thread:dm:assembly-${Date.now()}`;
    await fx.brain.handleInbound({
      threadId,
      senderSid: 'human:alice',
      message: {
        message_id: `msg:${Date.now()}`,
        parts: [{ type: 'text', text: '你好，装配烟雾' }],
      },
    });

    const out = fx.im.messagesMatching(/外脑未配置 LLM|无法生成回复/, threadId);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.body.text).toMatch(/外脑未配置 LLM/);
  });

  it('状态/密度快指令无 LLM 也能直接回复，且不落入 LLM 降级', async () => {
    const threadId = `thread:dm:status-${Date.now()}`;
    fx.kpiRegistry.create({
      description: '持续创作小说',
      createdBy: 'human:alice',
      kind: 'ongoing',
    });
    fx.innerBrainRegistry.register({
      instanceId: 'ib-status-run',
      workspaceId: 'task-ib-status-run',
      workDir: `${fx.workspacesDir}/task-ib-status-run`,
      goal: '修订第三章',
      originUser: 'human:alice',
      originThread: threadId,
      status: 'RUNNING',
      startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      ticks: 3,
    });

    await fx.brain.handleInbound({
      threadId,
      senderSid: 'human:alice',
      message: {
        message_id: `msg:status:${Date.now()}`,
        parts: [{ type: 'text', text: '状态' }],
      },
    });
    await fx.brain.handleInbound({
      threadId,
      senderSid: 'human:alice',
      message: {
        message_id: `msg:density:${Date.now()}`,
        parts: [{ type: 'text', text: '密度' }],
      },
    });

    expect(fx.im.messagesMatching(/当前进度/, threadId)).toHaveLength(1);
    expect(fx.im.messagesMatching(/修订第三章/, threadId)).toHaveLength(1);
    expect(fx.im.messagesMatching(/过去 24 小时/, threadId)).toHaveLength(1);
    expect(fx.im.messagesMatching(/执行密度/, threadId)).toHaveLength(1);
    expect(fx.im.messagesMatching(/外脑未配置 LLM/, threadId)).toHaveLength(0);
  });
});
