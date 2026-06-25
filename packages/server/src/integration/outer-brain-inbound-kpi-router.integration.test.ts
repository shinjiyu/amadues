/**
 * F 装配：OuterBrain.handleInbound 入站（方案一）。
 * 前置层不再派发/短路；人类消息流入对话环（本测无 LLM key → Step 4 降级回复，证明未被短路）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOuterBrainFixture, type OuterBrainFixture } from '../testing/outer-brain-fixture.js';

const LLM_ENV_KEYS = [
  'ZHIPU_API_KEY',
  'KIMI_API_KEY',
  'LOCALMODULE_API_KEY',
  'UTLRA_INNER_LLM_PROVIDER',
] as const;

describe('integration: outer brain inbound (方案一：前置不派发)', () => {
  let fx: OuterBrainFixture;
  const envSnapshot: Partial<Record<(typeof LLM_ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const k of LLM_ENV_KEYS) {
      if (process.env[k] !== undefined) envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
    process.env['UTLRA_OUTER_JITTER_MIN_MS'] = '0';
    process.env['UTLRA_OUTER_JITTER_MAX_MS'] = '0';
    process.env['UTLRA_AGENT_IM_SID'] = 'agent:inbound-kpi';
    fx = createOuterBrainFixture('agent:inbound-kpi');
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('KPI 类人类消息 → 前置层不建 KPI、不回模板，流入对话环（无 key 降级）', async () => {
    const threadId = `thread:kpi-router-${Date.now()}`;
    await fx.brain.handleInbound({
      threadId,
      senderSid: 'human:alice',
      message: {
        message_id: `msg:${Date.now()}`,
        parts: [{ type: 'text', text: '建立台湾情报常态收集，每天中午和晚上汇报简报' }],
      },
    });

    // 方案一：前置层零副作用——不建 KPI、不回「已登记 KPI」模板
    expect(fx.kpiRegistry.list().length).toBe(0);
    expect(fx.im.messagesMatching(/已登记 KPI/, threadId).length).toBe(0);
    // 消息流入对话环（无 LLM key → Step 4 降级回复），证明未被短路
    expect(fx.im.messagesMatching(/外脑未配置 LLM/, threadId).length).toBe(1);
  });

  it('一次性杂活类消息 → 前置层不派发、不回模板，流入对话环（无 key 降级）', async () => {
    const threadId = `thread:adhoc-router-${Date.now()}`;
    await fx.brain.handleInbound({
      threadId,
      senderSid: 'human:alice',
      message: {
        message_id: `msg:${Date.now()}`,
        parts: [{ type: 'text', text: '帮我查一下今天东京天气怎么样' }],
      },
    });

    expect(fx.im.messagesMatching(/已派发一次性任务/, threadId).length).toBe(0);
    expect(fx.innerBrainRegistry.list().length).toBe(0);
    expect(fx.im.messagesMatching(/外脑未配置 LLM/, threadId).length).toBe(1);
  });
});
