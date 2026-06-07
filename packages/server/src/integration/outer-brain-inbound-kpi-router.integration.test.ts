/**
 * F 装配：OuterBrain.handleInbound → inboundKpiRouter 在对话环前截获 KPI / ad-hoc。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOuterBrainFixture, type OuterBrainFixture } from '../testing/outer-brain-fixture.js';
import * as outerTools from '../outer/outer-tools.js';

const LLM_ENV_KEYS = [
  'ZHIPU_API_KEY',
  'KIMI_API_KEY',
  'LOCALMODULE_API_KEY',
  'UTLRA_INNER_LLM_PROVIDER',
] as const;

describe('integration: outer brain inbound KPI router', () => {
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

  it('KPI 类人类消息 → 路由器回复，不进入 LLM 对话环', async () => {
    vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已创建新内脑实例并启动任务 instance_id=ib-ob-kpi-1',
    });

    const threadId = `thread:kpi-router-${Date.now()}`;
    await fx.brain.handleInbound({
      threadId,
      senderSid: 'human:alice',
      message: {
        message_id: `msg:${Date.now()}`,
        parts: [{
          type: 'text',
          text: '建立台湾情报常态收集，每天中午和晚上汇报简报',
        }],
      },
    });

    const kpiReplies = fx.im.messagesMatching(/已登记 KPI/, threadId);
    expect(kpiReplies.length).toBe(1);
    expect(kpiReplies[0]!.body.text).toMatch(/已登记 KPI/);

    const llmFallback = fx.im.messagesMatching(/外脑未配置 LLM/, threadId);
    expect(llmFallback.length).toBe(0);
  });

  it('一次性杂活 → 路由器派发，不进入 LLM 对话环', async () => {
    vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已创建新内脑实例并启动任务 instance_id=ib-ob-adhoc-1',
    });

    const threadId = `thread:adhoc-router-${Date.now()}`;
    await fx.brain.handleInbound({
      threadId,
      senderSid: 'human:alice',
      message: {
        message_id: `msg:${Date.now()}`,
        parts: [{ type: 'text', text: '帮我查一下今天东京天气怎么样' }],
      },
    });

    const adHocReplies = fx.im.messagesMatching(/已派发一次性任务/, threadId);
    expect(adHocReplies.length).toBe(1);
  });
});
