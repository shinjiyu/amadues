/**
 * 外脑入站策略：是否应回复、是否参与群聊（对齐 openKuroneko outer-brain/index + participation）。
 * 渠道层（飞书/钉钉）只负责解析 raw 事件；**决策集中在本模块**，由 roundtrip 显式传入元数据。
 *
 * 可测性（doc/testing-strategy.md §S1、§S3）：
 * - env 经 `loadInboundConfigFromEnv()` 一次性解析为 `InboundConfig`；
 *   `shouldReplySyncRules` / `decideOuterShouldReply` 可显式接收 `config`，单测无需改 env。
 * - LLM 调用通过 `LlmChatFn` 注入点替换；缺省走 `llmChatCompletion`，对调用方零行为变化。
 */
import { llmChatCompletion } from '../llm/client.js';
import type { LlmChatOptions, LlmChatResult } from '../llm/types.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { getGroupParticipationState, recordProactiveSpeak } from './participation-state.js';

export type OuterThreadKind = 'dm' | 'group';

export type ProactiveLevel = 0 | 1 | 2 | 3;

export interface OuterInboundMeta {
  threadKind: OuterThreadKind;
  /** 群聊中用户是否 @ 了本 agent；DM 下通常为 true */
  isMentionAgent: boolean;
  /** 是否 @ 了他人（且不是「只 @ 本 agent」）；对齐飞书「只 @ 别人」不插嘴 */
  mentionsOthers: boolean;
  /** 跳过参与决策（owner / 调试） */
  skipParticipationCheck: boolean;
}

/** LLM 调用注入点（doc/testing-strategy.md §S3）；签名与 `llmChatCompletion` 完全一致。 */
export type LlmChatFn = (opts: LlmChatOptions) => Promise<LlmChatResult>;

/** 入站决策的全部可调参数（一律来源于 env，单测可替换） */
export interface InboundConfig {
  /** 主动发言强度（0 静默 → 3 积极） */
  proactiveLevel: ProactiveLevel;
  /** 群聊连续主动发言的冷却窗口（ms） */
  speakCooldownMs: number;
  /** 5 分钟内允许的最大主动发言次数 */
  maxProactivePer5Min: number;
  /** SPEAK/SILENT 判别是否调 LLM */
  useLlmForParticipation: boolean;
}

const PLACEHOLDER_RE = /^(\[图片\]|\[表情\]|\[语音\]|\[文件[^\]]*\])+$/;

export function isDmEmptyOrPlaceholderContent(content: string): boolean {
  const t = content.trim();
  if (!t) return true;
  return PLACEHOLDER_RE.test(t);
}

// ── env 解析（**唯一**允许碰 process.env 的位置） ──────────────────────────────

function parseProactiveLevel(raw: string | undefined): ProactiveLevel {
  const v = raw?.trim();
  if (v === '0' || v === '1' || v === '2' || v === '3') return Number(v) as ProactiveLevel;
  return 2;
}

function parseSpeakCooldownMs(raw: string | undefined): number {
  const n = Number(raw ?? '60000');
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

function parseMaxProactivePer5Min(raw: string | undefined): number {
  const n = Number(raw ?? '8');
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 8;
}

function parseUseLlmForParticipation(raw: string | undefined): boolean {
  const x = raw?.trim().toLowerCase();
  if (x === '0' || x === 'false' || x === 'no') return false;
  return true;
}

export function loadInboundConfigFromEnv(env: NodeJS.ProcessEnv = process.env): InboundConfig {
  return {
    proactiveLevel: parseProactiveLevel(env['UTLRA_OUTER_PROACTIVE_LEVEL']),
    speakCooldownMs: parseSpeakCooldownMs(env['UTLRA_OUTER_SPEAK_COOLDOWN_MS']),
    maxProactivePer5Min: parseMaxProactivePer5Min(env['UTLRA_OUTER_MAX_PROACTIVE_PER_5MIN']),
    useLlmForParticipation: parseUseLlmForParticipation(env['UTLRA_OUTER_PARTICIPATION_LLM']),
  };
}

// ── 兼容层：保持既有调用方签名不变 ────────────────────────────────────────────

export function resolveProactiveLevel(): number {
  return loadInboundConfigFromEnv().proactiveLevel;
}

/** 是否调用 LLM 做 SPEAK/SILENT；默认 true（有 key 时生效） */
export function resolveParticipationUseLlm(): boolean {
  return loadInboundConfigFromEnv().useLlmForParticipation;
}

// ── 决策函数 ──────────────────────────────────────────────────────────────────

export interface ShouldReplySyncResult {
  shouldReply: boolean;
  reason: string;
}

/**
 * 同步规则（无 LLM）。群聊非 @ 且可能需参与时，返回 shouldReply=false 表示「仍需 LLM 或已否决」。
 * - 若 reason 为 `needs_llm`，调用方应继续 `participationSpeakLlm`。
 *
 * `config` 可选；不传时一次性从 env 解析，便于既有调用方零改动。
 */
export function shouldReplySyncRules(
  params: {
    threadId: string;
    content: string;
    meta: OuterInboundMeta;
    proactiveLevel: number;
  },
  config: InboundConfig = loadInboundConfigFromEnv(),
): ShouldReplySyncResult {
  const { threadId, content, meta, proactiveLevel } = params;
  const level = proactiveLevel;

  if (meta.skipParticipationCheck) {
    return { shouldReply: true, reason: 'skip_participation_check' };
  }

  if (meta.threadKind === 'dm') {
    if (isDmEmptyOrPlaceholderContent(content)) {
      return { shouldReply: false, reason: 'dm_empty_or_placeholder' };
    }
    return { shouldReply: true, reason: 'dm' };
  }

  // —— 群聊 ——
  if (meta.isMentionAgent) {
    return { shouldReply: true, reason: 'group_mention_agent' };
  }

  if (meta.mentionsOthers) {
    return { shouldReply: false, reason: 'group_mention_others' };
  }

  if (level === 0) {
    return { shouldReply: false, reason: 'group_proactive_level_0' };
  }

  const state = getGroupParticipationState(threadId);
  const now = Date.now();

  if (now - state.lastProactiveAt < config.speakCooldownMs) {
    return { shouldReply: false, reason: 'group_cooldown' };
  }

  if (now - state.proactiveCountResetAt > 5 * 60 * 1000) {
    state.proactiveCount5min = 0;
    state.proactiveCountResetAt = now;
  }
  if (state.proactiveCount5min >= config.maxProactivePer5Min) {
    return { shouldReply: false, reason: 'group_max_proactive_5min' };
  }

  if (level === 1) {
    const t = content.trim();
    const isQ = t.endsWith('?') || t.endsWith('？');
    if (!isQ) {
      return { shouldReply: false, reason: 'group_level1_not_question' };
    }
  }

  const minLen = level >= 3 ? 2 : 3;
  if (content.trim().length < minLen) {
    return { shouldReply: false, reason: 'group_min_length' };
  }

  if (level >= 3) {
    const t = content.trim();
    if (
      /你们俩|你们俩先|大家.*(说|来|发表|商量|认识)|怎么都不说话|我让你们说话|都不说话了|都别不说话/.test(t) ||
      /我们来讨论|每人说一下|各自发表|先互相认识/.test(t)
    ) {
      return { shouldReply: true, reason: 'group_rule_group_invite' };
    }
  }

  return { shouldReply: false, reason: 'needs_llm' };
}

/**
 * SPEAK/SILENT 二分类（对齐 openKuroneko ParticipationEngine.askLLM，简化 persona）。
 *
 * `llmChat` 可选；缺省走 `llmChatCompletion`，便于单测注入。
 */
export async function participationSpeakLlm(
  env: InnerLlmEnv,
  input: {
    content: string;
    threadHistoryPrefix: string;
    innerStatusSummary: string;
    proactiveLevel: number;
  },
  llmChat: LlmChatFn = llmChatCompletion,
): Promise<boolean> {
  const level = input.proactiveLevel;
  const aggressiveness =
    level >= 3
      ? '像群成员一样自然参与'
      : level >= 2
        ? '正常参与：有贡献或话题相关时再发言'
        : '谨慎：只接直接问题';

  const systemPrompt = `你是群聊中的一员（外脑 agent）。当前消息**没有 @ 你**。
参与策略：${aggressiveness}。

必须保持沉默的情况（优先级最高）：
- 两人在聊与你无关的私事
- 话题完全与你无关且你无话可说

请只输出 SPEAK 或 SILENT，不要有其他内容。`;

  const userPrompt = `当前内脑状态摘要：
${input.innerStatusSummary.slice(0, 4000)}

最近线程摘要（goal 前缀）：
${input.threadHistoryPrefix.slice(0, 8000)}

新消息：
${input.content.slice(0, 8000)}`;

  const { content } = await llmChat({
    provider: env.provider,
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    model: env.textModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    // 注：实际只期望 1 个 token（SPEAK/SILENT），但 LocalModule（GLM-5.1-FP8）
    // 强制 thinking 模式且 thinking={type:'disabled'} 不生效（2026-05-17 prompt
    // 测试体系上线即捕获）。给 thinking 留 ~1k budget；产出仍只是 1 word，
    // 因为 finish_reason 是 stop 而非 length，多余 budget 不会真正吃 tokens。
    maxTokens: 1024,
    temperature: 0.2,
    thinking: 'disabled',
  });

  return content.trim().toUpperCase().includes('SPEAK');
}

/**
 * 完整决策：先同步规则，必要时 LLM。若最终应回复且为群聊非 @，更新频控状态。
 *
 * `config` / `llmChat` 都是可选注入点；既有调用方完全无感。
 */
export async function decideOuterShouldReply(params: {
  threadId: string;
  content: string;
  meta: OuterInboundMeta;
  proactiveLevel: number;
  threadHistoryPrefix: string;
  innerStatusSummary: string;
  llmEnv: InnerLlmEnv | null;
  /** 注入：见 `LlmChatFn` */
  llmChat?: LlmChatFn;
  /** 注入：见 `InboundConfig` */
  config?: InboundConfig;
}): Promise<{ shouldReply: boolean; reason: string }> {
  const config = params.config ?? loadInboundConfigFromEnv();
  const llmChat = params.llmChat ?? llmChatCompletion;

  const sync = shouldReplySyncRules(
    {
      threadId: params.threadId,
      content: params.content,
      meta: params.meta,
      proactiveLevel: params.proactiveLevel,
    },
    config,
  );

  if (sync.shouldReply || sync.reason !== 'needs_llm') {
    if (sync.shouldReply && sync.reason === 'group_rule_group_invite') {
      recordProactiveSpeak(params.threadId);
    }
    return { shouldReply: sync.shouldReply, reason: sync.reason };
  }

  if (!config.useLlmForParticipation || !params.llmEnv) {
    return { shouldReply: false, reason: 'participation_llm_disabled_or_no_key' };
  }

  try {
    const speak = await participationSpeakLlm(
      params.llmEnv,
      {
        content: params.content,
        threadHistoryPrefix: params.threadHistoryPrefix,
        innerStatusSummary: params.innerStatusSummary,
        proactiveLevel: params.proactiveLevel,
      },
      llmChat,
    );
    if (speak) {
      recordProactiveSpeak(params.threadId);
      return { shouldReply: true, reason: 'group_llm_speak' };
    }
    return { shouldReply: false, reason: 'group_llm_silent' };
  } catch (e) {
    console.error('[utlra] participationSpeakLlm failed', e);
    return { shouldReply: false, reason: 'participation_llm_error' };
  }
}
