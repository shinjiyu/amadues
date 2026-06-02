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

/** 参与决策时供同步规则 / SPEAK prompt 使用的 agent 上下文 */
export interface ParticipationAgentContext {
  agentName: string;
  /** active KPI 的自然语言描述（用于 KPI 相关判定） */
  activeKpiDescriptions?: string[];
}

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

export function resolveParticipationAgentContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  activeKpiDescriptions?: string[],
): ParticipationAgentContext {
  return {
    agentName: env['UTLRA_AGENT_NAME']?.trim() || 'Kuroneko',
    activeKpiDescriptions,
  };
}

/** 消息是否像在向某人提问或求助 */
export function looksLikeQuestion(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  if (t.endsWith('?') || t.endsWith('？')) return true;
  return (
    /^(请问|问一下|谁能|谁可以|有没有|谁知道|帮忙|帮(我|忙)|能否|可不可以)/.test(t) ||
    /(你觉得|你怎么看|你(知道|在吗|有空吗)|是吗|对不对|有没有问题)/.test(t)
  );
}

export function contentMentionsAgent(content: string, agentName: string): boolean {
  const name = agentName.trim().toLowerCase();
  if (!name) return false;
  const t = content.toLowerCase();
  return t.includes(name) || t.includes(`@${name}`);
}

/** 消息主题是否与某条 KPI 描述有明显重叠 */
export function contentRelatesToAgentKpi(content: string, descriptions: string[]): boolean {
  const t = content.trim().toLowerCase();
  if (!t || descriptions.length === 0) return false;
  for (const desc of descriptions) {
    const d = desc.trim().toLowerCase();
    if (!d) continue;
    const anchor = d.slice(0, Math.min(24, d.length));
    if (anchor.length >= 4 && t.includes(anchor)) return true;
    for (const seg of d.split(/[，,。；;、\s/|]+/)) {
      const s = seg.trim();
      if (s.length >= 4 && t.includes(s)) return true;
    }
  }
  return false;
}

export function buildParticipationSpeakSystemPrompt(
  _proactiveLevel: number,
  agentContext?: ParticipationAgentContext,
): string {
  const agentName = agentContext?.agentName?.trim() || '本 agent';

  return `你是 ${agentName}，群聊中的外脑 agent。
当前消息**没有 @ 你**，也**没有 @ 其他人**。

你的任务：判断这条消息**是在对谁说**。

**输出 SPEAK**（仅当满足以下全部条件）：
- 消息明确是在对你（${agentName}）说话：口头叫你名字、向你提问、或上下文表明在等你回答
- 不是在对群里其他人说话，也不是大家闲聊/广播

**输出 SILENT**（以下任一条即 SILENT）：
- 在对其他群成员说话（即使没写 @）
- 群友之间的私事、寒暄、与你不相关的讨论
- 只是陈述/分享，没有指向你、也没有在等你回应
- 不确定是不是在对你说 → 默认 SILENT

不要因为话题有趣或与你 KPI 略有关联就插嘴；只有确定「在对你说」才 SPEAK。

请只输出 SPEAK 或 SILENT，不要有其他内容。`;
}

function shouldRecordProactiveSpeak(reason: string): boolean {
  return reason === 'group_llm_speak';
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
    agentContext?: ParticipationAgentContext;
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
  // 1) @ 本 agent → 立即接话
  if (meta.isMentionAgent) {
    return { shouldReply: true, reason: 'group_mention_agent' };
  }

  // 2) @ 他人（不含本 agent）→ 不插嘴
  if (meta.mentionsOthers) {
    return { shouldReply: false, reason: 'group_mention_others' };
  }

  // 3) 未 @ 任何人：同步阶段一律不接话；proactiveLevel=0 时也不走 LLM
  if (level === 0) {
    return { shouldReply: false, reason: 'group_proactive_level_0' };
  }

  if (!config.useLlmForParticipation) {
    return { shouldReply: false, reason: 'group_no_mention_no_llm' };
  }

  // 4) 交给 LLM 判断「是否在对我说」（口头点名等也走此路径，不再同步 shortcut）
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
    agentContext?: ParticipationAgentContext;
  },
  llmChat: LlmChatFn = llmChatCompletion,
): Promise<boolean> {
  const systemPrompt = buildParticipationSpeakSystemPrompt(
    input.proactiveLevel,
    input.agentContext,
  );

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
    usageMeta: { source: 'outer_conversation', model: env.textModel, provider: env.provider },
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
  agentContext?: ParticipationAgentContext;
  /** 注入：见 `LlmChatFn` */
  llmChat?: LlmChatFn;
  /** 注入：见 `InboundConfig` */
  config?: InboundConfig;
}): Promise<{ shouldReply: boolean; reason: string }> {
  const config = params.config ?? loadInboundConfigFromEnv();
  const llmChat = params.llmChat ?? llmChatCompletion;

  const agentContext =
    params.agentContext ??
    resolveParticipationAgentContextFromEnv(process.env);

  const sync = shouldReplySyncRules(
    {
      threadId: params.threadId,
      content: params.content,
      meta: params.meta,
      proactiveLevel: params.proactiveLevel,
      agentContext,
    },
    config,
  );

  if (sync.shouldReply || sync.reason !== 'needs_llm') {
    return { shouldReply: sync.shouldReply, reason: sync.reason };
  }

  if (!params.llmEnv) {
    return { shouldReply: false, reason: 'participation_llm_disabled_or_no_key' };
  }

  const state = getGroupParticipationState(params.threadId);
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

  try {
    const speak = await participationSpeakLlm(
      params.llmEnv,
      {
        content: params.content,
        threadHistoryPrefix: params.threadHistoryPrefix,
        innerStatusSummary: params.innerStatusSummary,
        proactiveLevel: params.proactiveLevel,
        agentContext,
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
