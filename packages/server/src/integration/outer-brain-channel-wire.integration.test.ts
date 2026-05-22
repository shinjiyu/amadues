/**
 * F 装配：FakeIm channel 入站接线 → OuterBrain（模拟 index onAgentMessage 路径）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatIRInboundEvent } from '@utlra/chat-ir';
import { createOuterBrainFixture, type OuterBrainFixture } from '../testing/outer-brain-fixture.js';

const LLM_ENV_KEYS = [
  'ZHIPU_API_KEY',
  'KIMI_API_KEY',
  'LOCALMODULE_API_KEY',
  'UTLRA_INNER_LLM_PROVIDER',
] as const;

describe('integration: outer brain channel wire', () => {
  let fx: OuterBrainFixture;
  const envSnapshot: Partial<Record<(typeof LLM_ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const k of LLM_ENV_KEYS) {
      if (process.env[k] !== undefined) envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
    process.env['UTLRA_OUTER_JITTER_MIN_MS'] = '0';
    process.env['UTLRA_OUTER_JITTER_MAX_MS'] = '0';
    fx = createOuterBrainFixture('agent:channel-wire');
    fx.im.wireInbound((ev) =>
      fx.brain.handleInbound({
        threadId: ev.threadId,
        senderSid: ev.senderSid,
        message: ev.message,
        participantSids: ev.participantSids,
      }),
    );
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
  });

  it('emitInbound → handleInbound → FakeIm 降级出站', async () => {
    const threadId = `thread:dm:wire-${Date.now()}`;
    const ev: ChatIRInboundEvent = {
      threadId,
      senderSid: 'human:alice',
      participantSids: ['human:alice', 'agent:channel-wire'],
      message: {
        message_id: `msg:wire-${Date.now()}`,
        thread_id: threadId,
        sender_sid: 'human:alice',
        sent_at: new Date().toISOString(),
        parts: [{ type: 'text', text: 'channel 装配烟雾' }],
      },
    };

    await fx.im.emitInbound(ev);

    const out = fx.im.messagesMatching(/外脑未配置 LLM/, threadId);
    expect(out.length).toBeGreaterThan(0);
  });
});
