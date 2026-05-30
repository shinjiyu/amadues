/**
 * E.1：入站参与策略表驱动（FakeLLM，不走 OuterBrain 全链）。
 */
import { describe, expect, it } from 'vitest';

import {
  decideOuterShouldReply,
  type LlmChatFn,
} from '../outer/inbound-policy.js';
import { createFakeLLM } from '../testing/fake-llm.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';

const fakeLlmEnv: InnerLlmEnv = {
  provider: 'zhipu',
  apiKey: 'fake-key',
  baseUrl: 'https://example.test/v1',
  textModel: 'test',
  visionModel: 'test',
  maxTokensText: 512,
  maxTokensMultimodal: 512,
  thinking: 'disabled',
};

function thread(label: string): string {
  return `inbound-table:${label}:${Date.now()}`;
}

describe('integration: inbound policy table', () => {
  it('DM 有文本 → shouldReply + dm', async () => {
    const r = await decideOuterShouldReply({
      threadId: thread('dm'),
      content: '你好',
      meta: { threadKind: 'dm', isMentionAgent: true, mentionsOthers: false, skipParticipationCheck: false },
      proactiveLevel: 2,
      threadHistoryPrefix: '',
      innerStatusSummary: '',
      llmEnv: null,
      config: { proactiveLevel: 2, speakCooldownMs: 60_000, maxProactivePer5Min: 8, useLlmForParticipation: false },
    });
    expect(r.shouldReply).toBe(true);
    expect(r.reason).toBe('dm');
  });

  it('群聊 proactiveLevel=0 → 同步否决', async () => {
    const r = await decideOuterShouldReply({
      threadId: thread('group-silent'),
      content: '大家周末去哪',
      meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
      proactiveLevel: 0,
      threadHistoryPrefix: '',
      innerStatusSummary: '',
      llmEnv: null,
      config: { proactiveLevel: 0, speakCooldownMs: 60_000, maxProactivePer5Min: 8, useLlmForParticipation: false },
    });
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('group_proactive_level_0');
  });

  it('群聊 needs_llm + FakeLLM SILENT → group_llm_silent', async () => {
    const llm = createFakeLLM([
      { match: '是在对谁说', reply: { content: 'SILENT' } },
    ]);
    const llmChat: LlmChatFn = async (opts) => {
      const system = String(opts.messages.find((m) => m.role === 'system')?.content ?? '');
      const user = String(opts.messages.find((m) => m.role === 'user')?.content ?? '');
      const r = await llm.chat(system, [{ role: 'user', content: user }]);
      return { content: r.content ?? '' };
    };
    const r = await decideOuterShouldReply({
      threadId: thread('group-llm'),
      content: '明早机场见',
      meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
      proactiveLevel: 2,
      threadHistoryPrefix: 'Alice: 订酒店\nBob: 好的',
      innerStatusSummary: '无任务',
      llmEnv: fakeLlmEnv,
      llmChat,
      config: { proactiveLevel: 2, speakCooldownMs: 60_000, maxProactivePer5Min: 8, useLlmForParticipation: true },
    });
    expect(r.reason).toBe('group_llm_silent');
    expect(r.shouldReply).toBe(false);
  });
});
