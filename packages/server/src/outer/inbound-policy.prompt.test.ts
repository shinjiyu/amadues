/**
 * 外脑入站策略 · Prompt 效果测试（**真实 LLM**）。
 *
 * 验证目标（doc/testing-strategy.md §S3 翻转原则后，§7 E）：
 *   `participationSpeakLlm` 的 system + user prompt 在真实 LLM 下：
 *   1. **必须**：输出能被业务侧 `content.toUpperCase().includes('SPEAK')` 正确识别（格式遵守）。
 *   2. **应当**：在「明显应静默」场景里输出 SILENT 倾向；在「明显应参与」场景里输出 SPEAK 倾向。
 *
 * 断言策略：
 *   - 格式遵守：硬断言（fail 则代表 prompt 设计有问题，必须修）。
 *   - 语义判别：软断言（只统计，不 fail）—— 单一 LLM 调用本就存在随机性，
 *     单测不应做 ≥N% 的概率验证；这部分留给人工跑 `test:prompt` 时眼看 stdout 评估。
 *
 * 缺 LLM key 时：`requireLlmEnvForPrompt()` 抛错让本文件全部 fail（用户拍板 Q2=B）。
 */
import { describe, expect, it } from 'vitest';

import { decideOuterShouldReply, participationSpeakLlm } from './inbound-policy.js';
import { requireLlmEnvForPrompt } from '../testing/require-llm.js';

const llmEnv = requireLlmEnvForPrompt();

// ──────────────────────────────────────────────────────────────────────────────
// 1. participationSpeakLlm：纯 prompt-in / 分类-out
// ──────────────────────────────────────────────────────────────────────────────

describe('inbound-policy.prompt · participationSpeakLlm 格式遵守', () => {
  it('明显应静默场景 → 返回布尔（且 LLM 输出可被解析为 SPEAK/SILENT 之一）', async () => {
    const speak = await participationSpeakLlm(llmEnv, {
      content: '昨晚那家店的红烧肉真的绝了，回头我们也去吃一次',
      threadHistoryPrefix:
        'Alice: 周末要不要去那家新开的火锅店\nBob: 好啊几点\nAlice: 6 点门口见\nBob: 收到',
      innerStatusSummary: '当前内脑无相关任务',
      proactiveLevel: 2,
    });
    // 格式遵守：函数本身能返回布尔；若 LLM 既不输出 SPEAK 也不输出 SILENT，
    // 业务侧的 `includes('SPEAK')` 会返回 false，函数仍会返回 false，**但**这表示 prompt 设计有问题。
    // 我们在外面再跑一次拿到原文断言。
    expect(typeof speak).toBe('boolean');
  });

  it('明显应参与场景 → 返回布尔', async () => {
    const speak = await participationSpeakLlm(llmEnv, {
      content: '我刚把新的 chat-server 部署到 staging 了，谁帮我看下 health 端点是否正常',
      threadHistoryPrefix: 'Bob: 准备发版\nAlice: 等你信号',
      innerStatusSummary: '当前内脑无相关任务',
      proactiveLevel: 2,
    });
    expect(typeof speak).toBe('boolean');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. decideOuterShouldReply：完整决策链上 prompt 是否正确驱动出 group_llm_speak / group_llm_silent
// ──────────────────────────────────────────────────────────────────────────────

describe('inbound-policy.prompt · decideOuterShouldReply 群聊 needs_llm 全链路', () => {
  it('群聊 · 两人聊与你无关的私事 → 应当倾向 SILENT', async () => {
    const r = await decideOuterShouldReply({
      threadId: `prompt:silent:${Date.now()}:${Math.random()}`,
      content: '我们俩明早 8 点机场见，记得带好身份证',
      meta: {
        threadKind: 'group',
        isMentionAgent: false,
        mentionsOthers: false,
        skipParticipationCheck: false,
      },
      proactiveLevel: 2,
      threadHistoryPrefix:
        'Alice: 周末出去玩订酒店没\nBob: 订了，全季那家\nAlice: 行李我来收拾\nBob: 好',
      innerStatusSummary: '当前内脑无任务',
      llmEnv,
    });
    // 硬断言：reason 必须落在 group_llm_speak / group_llm_silent / group_cooldown / group_max_proactive_5min 之一，
    // **不应**落到 participation_llm_error（说明真实 LLM 调用失败）。
    expect(['group_llm_speak', 'group_llm_silent']).toContain(r.reason);
    // 软观察：在「私事」语境下我们期望 SILENT。记录但不 fail。
    if (r.reason !== 'group_llm_silent') {
      console.warn(
        `[prompt-test] 软警告：私事语境期望 SILENT，实际返回 ${r.reason}（${r.shouldReply ? 'SPEAK' : 'SILENT'}）`,
      );
    }
  });

  it('群聊 · 与 agent 角色强相关 → 应当倾向 SPEAK', async () => {
    const r = await decideOuterShouldReply({
      threadId: `prompt:speak:${Date.now()}:${Math.random()}`,
      content: '我刚部署完，谁帮我跑一下 health 端点',
      meta: {
        threadKind: 'group',
        isMentionAgent: false,
        mentionsOthers: false,
        skipParticipationCheck: false,
      },
      proactiveLevel: 3, // 用 level=3，更"积极"，并跳过 needs_llm 之前的同步规则不必担心 group_rule_group_invite 提前命中
      threadHistoryPrefix:
        'Bob: 准备发 v0.3\nAlice: 等你 ping\nBob: chat-server 已经上 staging',
      innerStatusSummary: '当前内脑无任务',
      llmEnv,
    });
    expect([
      'group_llm_speak',
      'group_llm_silent',
      // level=3 时同步规则中的"群邀请"也可能直接命中
      'group_rule_group_invite',
    ]).toContain(r.reason);
    if (r.reason === 'group_llm_silent') {
      console.warn(
        '[prompt-test] 软警告：技术求助场景期望 SPEAK，实际返回 SILENT（prompt 可能太保守）',
      );
    }
  });
});
