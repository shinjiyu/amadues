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
});
