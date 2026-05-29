/**
 * 外脑 LLM 对话循环（含工具调用）。
 * 每次外脑被触发时，构建完整上下文（知识 + 线程历史）后进入多轮 LLM 对话，
 * 直到 LLM 不再调用工具或达到最大轮数。
 *
 * 工具优先级：reply_to_user → set_goal → read_inner_status
 */
import type { IdentityRegistry } from '@utlra/chat-ir';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { llmRawChatCompletion } from '../llm/raw.js';
import { OUTER_TOOL_DEFS, executeOuterTool } from './outer-tools.js';
import type { OuterToolContext, ToolDef } from './outer-tools.js';
import { OUTER_ASYNC_ORCHESTRATION_GUIDE } from './brain-async-snapshot.js';
import {
  isToolOutputOk,
  recordOuterToolCall,
  recordOuterToolResult,
} from './outer-tool-audit.js';

// OpenAI-compatible 工具调用消息结构

export interface ToolCallEntry {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ConvMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallEntry[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface LlmToolCallResponse {
  content: string | null;
  tool_calls: ToolCallEntry[];
  raw: unknown;
}

/**
 * LLM 工具调用注入点（doc/testing-strategy.md §S3）。
 * 缺省实现走 raw 模式（保留与既有 provider 兼容的 max_tokens / temperature / thinking / tool_choice 行为）；
 * 单测注入替身后即可完全绕开 HTTP。
 */
export type LlmToolCallFn = (args: {
  env: InnerLlmEnv;
  messages: ConvMessage[];
  tools: ToolDef[];
  maxTokens: number;
}) => Promise<LlmToolCallResponse>;

// ── 带工具调用的 LLM 调用 ────────────────────────────────────────────────────

export const defaultOuterLlmToolCall: LlmToolCallFn = async ({ env, messages, tools, maxTokens }) => {
  const { raw } = await llmRawChatCompletion<{
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: ToolCallEntry[];
      };
    }>;
    error?: { message?: string };
  }>({
    provider: env.provider,
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    body: {
      model: env.textModel,
      messages,
      max_tokens: maxTokens,
      temperature: 0.6,
      thinking: { type: 'disabled' },
      tools,
      tool_choice: 'auto',
    },
  });

  const msg = raw.choices?.[0]?.message;
  return {
    content: msg?.content ?? null,
    tool_calls: msg?.tool_calls ?? [],
    raw,
  };
};

// ── 外脑系统提示 ──────────────────────────────────────────────────────────────

/**
 * 构建参与者身份表（sid ↔ 昵称），注入系统提示，让 LLM 知道如何正确 @mention 对方。
 *
 * 数据来源（动态，非 hardcode）：
 *  1. threadSids  — 本 thread 历史消息中出现过的所有 sender_sid（由外脑传入）
 *  2. registry    — 通过 sid 查 display_name / kind（heartbeat / 发消息时自动注册）
 * 未在 registry 中登记的 sid 会显示裸 sid（心跳到达前的短暂窗口）。
 */
function buildParticipantsBlock(
  registry: IdentityRegistry,
  agentSid: string,
  threadSids: string[],
): string {
  if (!threadSids.length) return '';
  const lines = threadSids.map((sid) => {
    const rec = registry.get(sid);
    const name = rec?.display_name ?? sid;
    const kind = rec?.kind ?? 'human';
    const tag = sid === agentSid ? '（你自己）' : kind === 'agent' ? '（agent）' : '（用户）';
    return `- 昵称：${name}  sid：${sid}  ${tag}`;
  });
  return (
    `## 当前对话参与者（sid ↔ 昵称映射）\n\n` +
    `${lines.join('\n')}\n\n` +
    `**@mention 规则**：在 reply_to_user 的 text 中用 "@昵称" 格式提及对方（如 @Shiro），` +
    `渠道桥会基于 IdentityRegistry 自动把 @token 解析为正确的 sid，无需手写 sid。`
  );
}

function buildSystemPrompt(
  agentSid: string,
  registry: IdentityRegistry,
  threadSids: string[],
  soul: string,
  longTermGoal: string,
  agentName: string,
): string {
  const participantsBlock = buildParticipantsBlock(registry, agentSid, threadSids);
  const goalSection = longTermGoal ? `\n# 长期目标\n${longTermGoal}\n` : '';

  return `你是 ${agentName}，正在参与一个实时 IM 聊天。你是对话中的一员，不是客服或助手。

# 灵魂设定（Soul）
${soul}
${goalSection}
## 聊天风格（最重要）
- **简短**：每条消息只说一个核心观点，通常 1-3 句话。能一句说清就不说两句。
- **口语化**：直接说，不用"首先""其次""综上"，不写标题和列表，就是正常聊天的语气。
- **不解释自己**：不说"作为 AI""根据我的分析"，直接表达观点。
- **不铺垫**：不用"很好的问题""我理解你的意思"这类废话开头。
- **群聊克制**：群里有其他人，不需要什么都说，说最关键的一点就够了。

${participantsBlock}

## 能力
- 聊天/讨论/观点：直接用 reply_to_user 回复，简短说清楚
- 一次性任务（写代码、搜索、整理文档）：set_goal 派发内脑
- **长期 / 开放式 / 多手段探索目标**（用户说"想办法"、"用任何手段"、"长期跟进"、"持续监控"、"这是个 KPI"等）：
  1. 先用 set_kpi 注册长期 KPI（拿到 kpi_id）
  2. **仅首次** set_goal 派 burst，**带上 kpi_id**；goal 里写清若需周期检查则让内脑用 wait_timer
  3. 一句话告诉用户："已建 KPI（id），开跑第一个尝试"
  4. burst 结束后用 view_kpi（含建议动作 achieved/follow_up/continue）；里程碑完成且已有产出时系统会自动 achieve_kpi
  5. 用户说某 KPI 已完成时：先 view_kpi 核对；若仍为 active 则 achieve_kpi；**不要**把已完成 KPI 继续列在「活跃」里
  6. async.is_async_waiting=true：**不要**再 set_goal，等 ChangeWatcher 或 send_directive
  7. 需换路线时：可再 set_goal（新尝试表述），**禁止**「第 2/3 轮监督检查」式重复 instance
  8. 内脑等用户输入：send_directive(feedback) 或引导用户回复
- **持续监督 Shiro / 周期巡检**：同一 KPI 只 set_goal 一次，内脑自行 wait_timer；不要每轮聊天再 set_goal
- @mention 用昵称，IM 会自动解析

${OUTER_ASYNC_ORCHESTRATION_GUIDE}

## 硬约束
- 必须用 reply_to_user 工具发送消息，不能只输出文本
- 存 Cookie/Token：对每个字段分别调用 keychain_put（如 key=zhihu__xsrf），禁止只口头说「已存入 keychain」而不调用工具；写入成功时工具返回含「已写入并校验」
- 禁止编造未知信息
- 禁止在 reply_to_user 的 text 里写 Markdown 链接（例如 \`[昵称](@sid:…)\`）；@人只用「@昵称」或「@显示名」纯文本，不要带 sid URI
- 每轮最多调用工具 ${MAX_TOOL_ROUNDS} 次`;
}

const MAX_TOOL_ROUNDS = 8;

/** 日志单行摘要，避免 tool output / LLM 正文刷屏 */
function logSnippet(text: string | null | undefined, maxLen = 160): string {
  if (!text?.trim()) return '(empty)';
  const oneLine = text.trim().replace(/\s+/g, ' ');
  return oneLine.length <= maxLen ? oneLine : `${oneLine.slice(0, maxLen)}…`;
}

/**
 * 外脑单次 LLM 调用最大 token。
 * 聊天回复靠提示词约束简洁，不靠截断；内脑任务（set_goal）需要足够上下文。
 * 可通过 UTLRA_OUTER_MAX_TOKENS 覆盖。
 */
const DEFAULT_OUTER_LOOP_MAX_TOKENS = 2048;

function resolveOuterLoopMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env['UTLRA_OUTER_MAX_TOKENS'] ?? String(DEFAULT_OUTER_LOOP_MAX_TOKENS));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OUTER_LOOP_MAX_TOKENS;
}

export interface ConversationLoopConfig {
  /** Agent 显示名（缺省 UTLRA_AGENT_NAME or 'Kuroneko'） */
  agentName: string;
  /** 单次 LLM 调用最大 token 数 */
  maxTokens: number;
}

export function loadConversationLoopConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConversationLoopConfig {
  return {
    agentName: env['UTLRA_AGENT_NAME']?.trim() || 'Kuroneko',
    maxTokens: resolveOuterLoopMaxTokens(env),
  };
}

// ── 主循环 ────────────────────────────────────────────────────────────────────

export interface ConversationLoopOptions {
  env: InnerLlmEnv;
  ctx: OuterToolContext;
  /** 身份注册表（用于查询 sid→昵称） */
  registry: IdentityRegistry;
  /**
   * 本 thread 中出现过的所有 sender_sid（动态收集，非 hardcode）。
   * 外脑在调用本函数前从 threads.json 中扫描得出。
   */
  threadSids: string[];
  /** 用户当前消息文本 */
  userMessage: string;
  /** 已格式化的知识 + 历史上下文 Markdown */
  knowledgeContext: string;
  /**
   * 从 soul.md 加载的 agent 灵魂设定文本。
   * 注入系统提示，定义 agent 的身份、性格与沟通风格。
   */
  soul: string;
  /**
   * 从 goal.md 加载的长期目标文本（可为空）。
   * 注入系统提示，让 agent 在聊天中也意识到自己的持续性使命。
   */
  longTermGoal: string;
  /**
   * LLM 调用注入点（doc/testing-strategy.md §S3）。
   * 缺省走 `defaultOuterLlmToolCall`（raw 模式），单测可注入 fake。
   */
  callLlm?: LlmToolCallFn;
  /**
   * 运行参数。缺省 `loadConversationLoopConfigFromEnv()`。
   */
  config?: ConversationLoopConfig;
}

export interface ConversationLoopResult {
  replied: boolean;
  roundsUsed: number;
  lastContent: string | null;
  /** 本轮对话中调用过的工具名称列表（如 ["set_goal", "reply_to_user"]） */
  toolsUsed: string[];
}

export async function runOuterConversationLoop(
  opts: ConversationLoopOptions,
): Promise<ConversationLoopResult> {
  const { env, ctx, registry, threadSids, userMessage, knowledgeContext, soul, longTermGoal } = opts;
  const config = opts.config ?? loadConversationLoopConfigFromEnv();
  const callLlm = opts.callLlm ?? defaultOuterLlmToolCall;

  const systemPrompt = buildSystemPrompt(
    ctx.agentSid,
    registry,
    threadSids,
    soul,
    longTermGoal,
    config.agentName,
  );

  // 当前时间标签：让 LLM 知道此刻是几点，感知时间节奏
  const now    = new Date();
  const hhmm   = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const nowTag = `【现在 ${hhmm}】`;

  // 背景知识放在前面作为参考，用户消息明确标出，保持简洁
  const userContent = knowledgeContext
    ? `${knowledgeContext}\n\n---\n\n${nowTag} 收到的消息：${userMessage}`
    : `${nowTag} ${userMessage}`;

  const messages: ConvMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  let replied = false;
  let roundsUsed = 0;
  let lastContent: string | null = null;
  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    roundsUsed++;
    let resp: LlmToolCallResponse;
    try {
      resp = await callLlm({
        env,
        messages,
        tools: OUTER_TOOL_DEFS,
        maxTokens: config.maxTokens,
      });
    } catch (e) {
      console.error('[utlra][outer-loop] LLM call failed', e);
      break;
    }

    lastContent = resp.content ?? null;

    if (!resp.tool_calls.length) {
      console.log(
        `[utlra][outer-loop] round ${roundsUsed}/${MAX_TOOL_ROUNDS} no-tools replied=${replied} content=${logSnippet(resp.content)}`,
      );
      // LLM 没有调用工具——兜底：有文本且未回复时直接发送，但先做 freshCheck
      if (!replied && resp.content?.trim()) {
        let shouldSend = true;
        if (ctx.freshCheck) {
          try {
            shouldSend = !(await ctx.freshCheck());
          } catch {
            shouldSend = true;
          }
        }
        if (shouldSend) {
          try {
            await ctx.imClient.postMessage(ctx.threadId, {
              sender_sid: ctx.agentSid,
              text: resp.content.trim(),
            });
            replied = true;
          } catch (e) {
            console.error('[utlra][outer-loop] fallback reply failed', e);
          }
        } else {
          console.log('[utlra][outer-loop] abort fallback: another agent already replied');
        }
      }
      break;
    }

    // 追加 assistant 消息（含 tool_calls）
    messages.push({
      role: 'assistant',
      content: resp.content ?? null,
      tool_calls: resp.tool_calls,
    });

    // 依次执行所有工具调用
    let shouldAbort = false;
    for (const tc of resp.tool_calls) {
      recordOuterToolCall({
        dataRoot: ctx.dataRoot,
        agentSid: ctx.agentSid,
        threadId: ctx.threadId,
        round: roundsUsed,
        toolName: tc.function.name,
        argsJson: tc.function.arguments,
        actionLogStore: ctx.actionLogStore,
      });

      const t0 = Date.now();
      let toolOut: { replied: boolean; output: string; abortLoop?: boolean };
      try {
        toolOut = await executeOuterTool(tc.function.name, tc.function.arguments, ctx);
      } catch (e) {
        toolOut = {
          replied: false,
          output: `工具执行错误：${e instanceof Error ? e.message : String(e)}`,
        };
      }
      const ok = isToolOutputOk(toolOut.output);
      recordOuterToolResult({
        dataRoot: ctx.dataRoot,
        agentSid: ctx.agentSid,
        threadId: ctx.threadId,
        round: roundsUsed,
        toolName: tc.function.name,
        output: toolOut.output,
        ok,
        durationMs: Date.now() - t0,
        actionLogStore: ctx.actionLogStore,
      });

      toolsUsed.push(tc.function.name);
      if (toolOut.replied) replied = true;
      if (toolOut.abortLoop) shouldAbort = true;

      console.log(
        `[utlra][outer-loop] round ${roundsUsed}/${MAX_TOOL_ROUNDS} tool=${tc.function.name} ok=${ok} toolReplied=${toolOut.replied} loopReplied=${replied} abort=${!!toolOut.abortLoop} out=${logSnippet(toolOut.output, 120)}`,
      );

      // 工具结果追加到消息历史
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolOut.output,
      });
    }

    // abortLoop：freshCheck 命中，另一个 agent 已接单，立即中止整个循环
    if (shouldAbort) {
      console.log('[utlra][outer-loop] abort: another agent claimed the task, stopping loop');
      break;
    }

    // 如果已回复且没有强制继续的工具，可以提前终止
    if (replied && resp.tool_calls.every((tc) => tc.function.name === 'reply_to_user')) {
      break;
    }
  }

  const toolsChain = toolsUsed.length ? toolsUsed.join('→') : '(none)';
  console.log(
    `[utlra][outer-loop] done: replied=${replied} rounds=${roundsUsed} tools=${toolsChain} lastContent=${logSnippet(lastContent)}`,
  );

  return { replied, roundsUsed, lastContent, toolsUsed };
}
