/**
 * ADL component: participationPolicy
 * path: packages/server/src/outer/inbound-policy.ts (+ participation-state.ts)
 * horizon.in:  OuterInboundMeta, threadId, content, agentSid?
 * horizon.out: { shouldReply, reason }
 *
 * 组件维度的黑盒契约测（doc/structurizr/COMPONENT-TESTING.md）。
 * 同步规则 + 注入 Fake LLM 的群聊路径；不经过 OuterBrainFacade 全链。
 */
import { describe, expect, it } from 'vitest';

import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import {
  type InboundConfig,
  type LlmChatFn,
  decideOuterShouldReply,
} from './inbound-policy.js';

function makeConfig(overrides: Partial<InboundConfig> = {}): InboundConfig {
  return {
    proactiveLevel: 2,
    speakCooldownMs: 60_000,
    maxProactivePer5Min: 8,
    useLlmForParticipation: true,
    ...overrides,
  };
}

const llmEnv: InnerLlmEnv = {
  provider: 'kimi',
  apiKey: 'test',
  baseUrl: 'https://example.test',
  textModel: 'test-model',
  visionModel: 'test-model',
  maxTokensText: 256,
  maxTokensMultimodal: 256,
  thinking: 'disabled',
};

function thread(name: string): string {
  return `component:participationPolicy:${name}:${Math.random().toString(36).slice(2, 8)}`;
}

describe('component: participationPolicy', () => {
  it('DM 有文本 → shouldReply（主路径）', async () => {
    const r = await decideOuterShouldReply({
      threadId: thread('dm-main'),
      content: '请帮我总结',
      meta: {
        threadKind: 'dm',
        isMentionAgent: true,
        mentionsOthers: false,
        skipParticipationCheck: false,
      },
      proactiveLevel: 2,
      threadHistoryPrefix: '',
      innerStatusSummary: '',
      llmEnv,
      config: makeConfig({ useLlmForParticipation: false }),
    });
    expect(r.shouldReply).toBe(true);
    expect(r.reason).toBe('dm');
  });

  it('群聊未 @ 且 level=0 → 不参与（拒绝路径）', async () => {
    const r = await decideOuterShouldReply({
      threadId: thread('group-silent'),
      content: '大家聊',
      meta: {
        threadKind: 'group',
        isMentionAgent: false,
        mentionsOthers: false,
        skipParticipationCheck: false,
      },
      proactiveLevel: 0,
      threadHistoryPrefix: '',
      innerStatusSummary: '',
      llmEnv: null,
      config: makeConfig({ proactiveLevel: 0, useLlmForParticipation: false }),
    });
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('group_proactive_level_0');
  });

  it('群聊 needs_llm + Fake LLM 返回 SPEAK → shouldReply（依赖注入）', async () => {
    const llmChat: LlmChatFn = async () => ({
      content: 'SPEAK',
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const r = await decideOuterShouldReply({
      threadId: thread('group-llm'),
      content: '谁能帮看下部署日志有没有报错',
      meta: {
        threadKind: 'group',
        isMentionAgent: false,
        mentionsOthers: false,
        skipParticipationCheck: false,
      },
      proactiveLevel: 3,
      threadHistoryPrefix: '（无历史）',
      innerStatusSummary: '内脑 idle',
      llmEnv,
      config: makeConfig({ proactiveLevel: 3 }),
      llmChat,
    });
    expect(r.shouldReply).toBe(true);
    expect(r.reason).toBe('group_llm_speak');
  });
});
