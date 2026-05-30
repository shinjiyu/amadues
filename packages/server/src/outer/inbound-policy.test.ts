/**
 * 外脑入站策略（"是否回话"）单元测试。
 *
 * 单元层职责（doc/testing-strategy.md §S3 翻转原则后）：
 *   - 覆盖**纯函数 / 同步规则 / 错误兜底**等不依赖 prompt 效果的路径；
 *   - 涉及 prompt 设计是否能产出 SPEAK/SILENT 的语义判断，**已迁出到** `inbound-policy.prompt.test.ts`（真实 LLM）。
 *
 * 用 C-1 暴露的注入点：`config: InboundConfig` + `llmChat: LlmChatFn`。
 * 完全不读环境变量、不发 HTTP；participation-state 是模块内 Map，
 * 因此每个用例使用**唯一 threadId**避免跨用例污染。
 */
import { describe, expect, it } from 'vitest';

import {
  type InboundConfig,
  type LlmChatFn,
  decideOuterShouldReply,
  isDmEmptyOrPlaceholderContent,
  loadInboundConfigFromEnv,
  shouldReplySyncRules,
  contentMentionsAgent,
  contentRelatesToAgentKpi,
  looksLikeQuestion,
} from './inbound-policy.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';

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

function uniqueThread(name: string): string {
  return `inbound-test:${name}:${Math.random().toString(36).slice(2, 8)}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 同步路径：DM
// ──────────────────────────────────────────────────────────────────────────────

describe('inbound-policy · isDmEmptyOrPlaceholderContent', () => {
  it('空 / 仅 placeholder → true', () => {
    expect(isDmEmptyOrPlaceholderContent('')).toBe(true);
    expect(isDmEmptyOrPlaceholderContent('   ')).toBe(true);
    expect(isDmEmptyOrPlaceholderContent('[图片]')).toBe(true);
    expect(isDmEmptyOrPlaceholderContent('[图片][语音]')).toBe(true);
    expect(isDmEmptyOrPlaceholderContent('[文件 report.pdf]')).toBe(true);
  });

  it('含文本 → false', () => {
    expect(isDmEmptyOrPlaceholderContent('你好')).toBe(false);
    expect(isDmEmptyOrPlaceholderContent('[图片] 看下')).toBe(false);
  });
});

describe('inbound-policy · shouldReplySyncRules · DM', () => {
  it('DM 非空 → shouldReply=true', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('dm-text'),
        content: '帮我看下',
        meta: { threadKind: 'dm', isMentionAgent: true, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 2,
      },
      makeConfig(),
    );
    expect(r).toEqual({ shouldReply: true, reason: 'dm' });
  });

  it('DM 仅 placeholder → 不回', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('dm-empty'),
        content: '[图片]',
        meta: { threadKind: 'dm', isMentionAgent: true, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 2,
      },
      makeConfig(),
    );
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('dm_empty_or_placeholder');
  });

  it('skipParticipationCheck → 始终回（owner / 调试）', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('skip'),
        content: '',
        meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: true, skipParticipationCheck: true },
        proactiveLevel: 0,
      },
      makeConfig(),
    );
    expect(r.shouldReply).toBe(true);
    expect(r.reason).toBe('skip_participation_check');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 同步路径：群聊
// ──────────────────────────────────────────────────────────────────────────────

describe('inbound-policy · shouldReplySyncRules · group', () => {
  it('@本 agent → 立即回', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('group-at'),
        content: '你怎么看？',
        meta: { threadKind: 'group', isMentionAgent: true, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 2,
      },
      makeConfig(),
    );
    expect(r).toEqual({ shouldReply: true, reason: 'group_mention_agent' });
  });

  it('@他人（不含 agent）→ 不插嘴', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('group-others'),
        content: '@Alice 看下',
        meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: true, skipParticipationCheck: false },
        proactiveLevel: 3,
      },
      makeConfig(),
    );
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('group_mention_others');
  });

  it('proactiveLevel=0 → 群聊永远静默', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('group-l0'),
        content: '今天天气真好？',
        meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 0,
      },
      makeConfig({ proactiveLevel: 0 }),
    );
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('group_proactive_level_0');
  });

  it('level 1 非问句 → needs_llm（不再同步接话）', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('group-l1-not-q'),
        content: '今天天气真好',
        meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 1,
      },
      makeConfig({ proactiveLevel: 1 }),
    );
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('needs_llm');
  });

  it('level 2 短消息 → needs_llm（不再 group_min_length 拦截）', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('group-min'),
        content: '嗯',
        meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 2,
      },
      makeConfig(),
    );
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('needs_llm');
  });

  it('level 3 "你们俩说说" → needs_llm（不再同步群邀请接话）', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('group-invite'),
        content: '你们俩先互相认识下',
        meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 3,
      },
      makeConfig({ proactiveLevel: 3 }),
    );
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('needs_llm');
  });

  it('level 2 一般陈述句 → needs_llm', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('group-needs-llm'),
        content: '我刚搭好开发环境，构建挺顺利',
        meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 2,
      },
      makeConfig(),
    );
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('needs_llm');
  });

  it('口头点名 + 问句 → needs_llm（不再同步 shortcut）', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('group-addressed'),
        content: 'Gin 你觉得 health 端点正常吗？',
        meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 2,
        agentContext: { agentName: 'Gin', activeKpiDescriptions: [] },
      },
      makeConfig(),
    );
    expect(r).toEqual({ shouldReply: false, reason: 'needs_llm' });
  });

  it('KPI 关键词命中 → needs_llm（不再同步 shortcut）', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('group-kpi'),
        content: 'chat-server staging 的 health 端点谁看过',
        meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 2,
        agentContext: {
          agentName: 'Gin',
          activeKpiDescriptions: ['维护 chat-server staging 部署与 health 监控'],
        },
      },
      makeConfig(),
    );
    expect(r).toEqual({ shouldReply: false, reason: 'needs_llm' });
  });

  it('「你那边/你刚」类问句 → needs_llm（不再同步 shortcut）', () => {
    const r = shouldReplySyncRules(
      {
        threadId: uniqueThread('group-you'),
        content: '你那边部署完了吗？',
        meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
        proactiveLevel: 2,
        agentContext: { agentName: 'Gin' },
      },
      makeConfig(),
    );
    expect(r).toEqual({ shouldReply: false, reason: 'needs_llm' });
  });
});

describe('inbound-policy · participation helpers', () => {
  it('looksLikeQuestion 识别问句与求助', () => {
    expect(looksLikeQuestion('health 正常吗？')).toBe(true);
    expect(looksLikeQuestion('谁能帮看下')).toBe(true);
    expect(looksLikeQuestion('今天天气不错')).toBe(false);
  });

  it('contentMentionsAgent 大小写不敏感', () => {
    expect(contentMentionsAgent('gin 在吗', 'Gin')).toBe(true);
    expect(contentMentionsAgent('@gin 看下', 'Gin')).toBe(true);
  });

  it('contentRelatesToAgentKpi 匹配 KPI 描述片段', () => {
    expect(
      contentRelatesToAgentKpi('staging health 挂了', ['维护 chat-server staging 部署']),
    ).toBe(true);
    expect(contentRelatesToAgentKpi('今晚吃火锅', ['维护 chat-server staging 部署'])).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// decideOuterShouldReply：含 LLM 路径
// ──────────────────────────────────────────────────────────────────────────────

describe('inbound-policy · decideOuterShouldReply', () => {
  it('DM 直接同步通过，不调用 LLM', async () => {
    let called = 0;
    const llmChat: LlmChatFn = async () => { called++; return { content: 'SPEAK', raw: {} }; };

    const r = await decideOuterShouldReply({
      threadId: uniqueThread('dm-no-llm'),
      content: '你能帮我吗',
      meta: { threadKind: 'dm', isMentionAgent: true, mentionsOthers: false, skipParticipationCheck: false },
      proactiveLevel: 2,
      threadHistoryPrefix: '',
      innerStatusSummary: '',
      llmEnv,
      llmChat,
      config: makeConfig(),
    });
    expect(r.shouldReply).toBe(true);
    expect(called).toBe(0);
  });

  // 注：SPEAK/SILENT 走真实 LLM 判别的两条路径迁移到 `inbound-policy.prompt.test.ts`（doc/testing-strategy.md §S3）。
  //     单测只保留**不依赖 prompt 效果**的兜底：disabled / no-key / 抛错。

  it('useLlmForParticipation=false → 不调 LLM，直接不回', async () => {
    let called = 0;
    const llmChat: LlmChatFn = async () => { called++; return { content: 'SPEAK', raw: {} }; };

    const r = await decideOuterShouldReply({
      threadId: uniqueThread('group-llm-off'),
      content: '昨天那次发布挺顺的',
      meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
      proactiveLevel: 2,
      threadHistoryPrefix: '',
      innerStatusSummary: '',
      llmEnv,
      llmChat,
      config: makeConfig({ useLlmForParticipation: false }),
    });
    expect(called).toBe(0);
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('group_no_mention_no_llm');
  });

  it('LLM 抛错 → 兜底不回（不抛给上游）', async () => {
    const llmChat: LlmChatFn = async () => { throw new Error('boom'); };

    const r = await decideOuterShouldReply({
      threadId: uniqueThread('group-llm-error'),
      content: '昨天那次发布挺顺的',
      meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
      proactiveLevel: 2,
      threadHistoryPrefix: '',
      innerStatusSummary: '',
      llmEnv,
      llmChat,
      config: makeConfig(),
    });
    expect(r.shouldReply).toBe(false);
    expect(r.reason).toBe('participation_llm_error');
  });

  it('llmEnv=null + needs_llm → 不调 LLM，直接不回', async () => {
    let called = 0;
    const llmChat: LlmChatFn = async () => { called++; return { content: 'SPEAK', raw: {} }; };

    const r = await decideOuterShouldReply({
      threadId: uniqueThread('group-no-env'),
      content: '昨天那次发布挺顺的',
      meta: { threadKind: 'group', isMentionAgent: false, mentionsOthers: false, skipParticipationCheck: false },
      proactiveLevel: 2,
      threadHistoryPrefix: '',
      innerStatusSummary: '',
      llmEnv: null,
      llmChat,
      config: makeConfig(),
    });
    expect(called).toBe(0);
    expect(r.shouldReply).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// loadInboundConfigFromEnv：env 解析鲁棒性
// ──────────────────────────────────────────────────────────────────────────────

describe('inbound-policy · loadInboundConfigFromEnv', () => {
  it('空 env → 默认值', () => {
    expect(loadInboundConfigFromEnv({})).toEqual({
      proactiveLevel: 2,
      speakCooldownMs: 60_000,
      maxProactivePer5Min: 8,
      useLlmForParticipation: true,
    });
  });

  it('合法覆盖 → 全部生效', () => {
    expect(
      loadInboundConfigFromEnv({
        UTLRA_OUTER_PROACTIVE_LEVEL: '3',
        UTLRA_OUTER_SPEAK_COOLDOWN_MS: '12345',
        UTLRA_OUTER_MAX_PROACTIVE_PER_5MIN: '4',
        UTLRA_OUTER_PARTICIPATION_LLM: 'false',
      }),
    ).toEqual({
      proactiveLevel: 3,
      speakCooldownMs: 12345,
      maxProactivePer5Min: 4,
      useLlmForParticipation: false,
    });
  });

  it('非法 level / 负值 / 非数字 → fallback 默认', () => {
    expect(
      loadInboundConfigFromEnv({
        UTLRA_OUTER_PROACTIVE_LEVEL: '7',
        UTLRA_OUTER_SPEAK_COOLDOWN_MS: '-5',
        UTLRA_OUTER_MAX_PROACTIVE_PER_5MIN: 'abc',
      }),
    ).toMatchObject({
      proactiveLevel: 2,
      speakCooldownMs: 60_000,
      maxProactivePer5Min: 8,
    });
  });

  it('UTLRA_OUTER_PARTICIPATION_LLM 多种关闭写法都识别', () => {
    for (const off of ['0', 'false', 'no', 'FALSE', 'NO']) {
      expect(loadInboundConfigFromEnv({ UTLRA_OUTER_PARTICIPATION_LLM: off }).useLlmForParticipation).toBe(false);
    }
    for (const on of ['', '1', 'true', 'yes']) {
      expect(loadInboundConfigFromEnv({ UTLRA_OUTER_PARTICIPATION_LLM: on }).useLlmForParticipation).toBe(true);
    }
  });
});
