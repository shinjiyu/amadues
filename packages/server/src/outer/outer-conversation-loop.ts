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
import { OUTER_REPLY_ONLY_TOOL_DEFS, OUTER_TOOL_DEFS, executeOuterTool } from './outer-tools.js';
import type { OuterToolContext, ToolDef } from './outer-tools.js';
import { OUTER_ASYNC_ORCHESTRATION_GUIDE } from './brain-async-snapshot.js';
import { OUTER_EXECUTABLE_WORKFLOW_GUIDE } from './executable-workflow-guide.js';
import {
  isToolOutputOk,
  recordOuterToolCall,
  recordOuterToolResult,
} from './outer-tool-audit.js';
import {
  EMPTY_PROMISE_RECOVERY_SYSTEM,
  shouldReconcileEmptyPromise,
  type OuterToolResultSnap,
} from './empty-promise-reconcile.js';
import { formatAgentNowTag } from '../agent-time.js';

function extractReplyTextFromArgs(argsJson: string): string | null {
  try {
    const args = JSON.parse(argsJson) as { text?: unknown };
    return typeof args.text === 'string' && args.text.trim() ? args.text.trim() : null;
  } catch {
    return null;
  }
}

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
export type LlmToolChoice =
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export type LlmToolCallFn = (args: {
  env: InnerLlmEnv;
  messages: ConvMessage[];
  tools: ToolDef[];
  maxTokens: number;
  toolChoice?: LlmToolChoice;
}) => Promise<LlmToolCallResponse>;

// ── 带工具调用的 LLM 调用 ────────────────────────────────────────────────────

export const defaultOuterLlmToolCall: LlmToolCallFn = async ({
  env,
  messages,
  tools,
  maxTokens,
  toolChoice = 'auto',
}) => {
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
    usageMeta: { source: 'outer_conversation', model: env.textModel, provider: env.provider },
    body: {
      model: env.textModel,
      messages,
      max_tokens: maxTokens,
      temperature: 0.6,
      thinking: { type: 'disabled' },
      tools,
      tool_choice: toolChoice,
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
- 一次性任务（写代码、搜索、整理文档）：set_goal 派发内脑（无 kpi_id）——默认 **explore**
- **再跑已知流程**（用户说按上次/不要摸索/确定性执行/指定 workflow）：\`workflow_list\` → \`set_goal(burst_mode=execute, workflow_id, workflow_version)\` 或 \`workflow_run\`（以用户指定为准）
- **聊天指定固化**（用户说晋升/冻结/存成工作流）：\`workflow_suggest_promote\`（可选）→ **必须** \`workflow_promote\`（可带 workspace_id / playbook_path / dag_path / steps_json）
- **EW 跑坏了要自修**：系统会记 \`ew_revision\` 并派 explore；修好后 ATTRIBUTE \`promote_executable_workflow\` **同 id** 升版（可带 base_workflow_*）。不要手改 workflows JSON
- **探索成功后自动固化**：内脑 ATTRIBUTE 会调 \`promote_executable_workflow\`；你可用 \`workflow_list\` 核对结果
- **长期 / 开放式 / 周期目标**（"想办法"、"长期跟进"、"持续监控"、"每日收集"、"这是个 KPI"等）：
  1. 先用 set_kpi（周期/常驻用 kind=ongoing）注册，拿到 kpi_id；系统通常会自动 advance 首轮
  2. 需要立刻再推一发时用 **advance_kpi**（不要 set_goal(kpi_id)）；goal/charter 写清**本轮**窄产出
  3. **双轨**（同一 KPI 可同时）：**实时**——有容量时数字员工环会 bootstrap/repair；**定时**——基线有产物后 employeeCalendar 会 ensure cron 式增量日程，到期再派。**禁止**说「系统没有定时/cron/日历」
  4. **聊天预约 / 提醒 / 到点派活**：用 **schedule_commitment**（remind 或 spawn_goal）；查日程用 **list_calendar**；取消/暂停用 cancel/pause_commitment
  4a. **一天 N 次报告**：优先一条多小时 cron（如 0 9,13,21 * * * + timezone=Asia/Shanghai），不要连建三条默认 kpi_increment（默认键会互相覆盖）；若建多条必须显式不同 calendar_key
  5. **禁止**内脑 wait_timer 长睡做周期检查；每个 burst 做完本轮即结束
  6. 一句话告诉用户："已建 KPI（id），首轮已开跑；日常增量走日程，紧急可再催"
  7. burst 结束后用 view_kpi；用户确认完成 → achieve_kpi；勿把已完成 KPI 仍当「活跃」
  8. 健康 RUNNING / 未到期日历：**不要**聊天里反复派发；用户问进度用 list_inner_brains / view_kpi / list_calendar
  9. async.is_async_waiting=true：勿抢派，等 ChangeWatcher 或 send_directive
  10. 内脑等用户输入：send_directive(feedback) 或引导用户回复
- **持续监督 / 每日巡检**：ongoing KPI + 双轨；不要每轮聊天再 advance，也不要停掉健康在跑的内脑只为「改成定时」
- @mention 用昵称，IM 会自动解析

${OUTER_EXECUTABLE_WORKFLOW_GUIDE}

${OUTER_ASYNC_ORCHESTRATION_GUIDE}

## 硬约束
- 必须用 reply_to_user 工具发送消息，不能只输出文本
- 存 Cookie/Token/账号：keychain_put 入库（独立保管，防长对话丢失）；派内脑前 keychain_get 取明文并**写入 set_goal 的 goal 正文**，勿指望内脑自己去 vault 挖
- 禁止只口头说「已存入 keychain」而不调用工具；写入成功时工具返回含「已写入并校验」
- 用户祈使要做事时：必须先成功调用 set_goal / advance_kpi / workflow_run / workflow_promote / set_kpi / schedule_commitment / send_directive 之一，再 reply；禁止只口头说「我去办 / 这就开跑 / 已派内脑」
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
  /** 主循环未回复时触发了 reply_to_user 强制收尾轮 */
  forcedReplyRecovery?: boolean;
  /** 口头答应做事但未派活 → 触发了空口对账纠偏轮 */
  emptyPromiseRecovery?: boolean;
}

const RECOVERY_FALLBACK_TEXT =
  '抱歉，刚才处理久了点。我在这，你刚说的我收到了。';

function pickRecoveryFallbackText(lastContent: string | null, messages: ConvMessage[]): string {
  if (lastContent?.trim()) return lastContent.trim();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content.trim();
    }
  }
  return RECOVERY_FALLBACK_TEXT;
}

async function executeReplyToolCall(
  tc: ToolCallEntry,
  round: number,
  ctx: OuterToolContext,
  toolsUsed: string[],
  toolResults?: OuterToolResultSnap[],
  replyTexts?: string[],
): Promise<{ replied: boolean; abortLoop: boolean; output: string }> {
  recordOuterToolCall({
    dataRoot: ctx.dataRoot,
    agentSid: ctx.agentSid,
    threadId: ctx.threadId,
    round,
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
    round,
    toolName: tc.function.name,
    output: toolOut.output,
    ok,
    durationMs: Date.now() - t0,
    actionLogStore: ctx.actionLogStore,
  });

  toolsUsed.push(tc.function.name);
  toolResults?.push({ name: tc.function.name, output: toolOut.output });
  if (tc.function.name === 'reply_to_user') {
    const text = extractReplyTextFromArgs(tc.function.arguments);
    if (text) replyTexts?.push(text);
  }
  console.log(
    `[utlra][outer-loop] round ${round} tool=${tc.function.name} ok=${ok} toolReplied=${toolOut.replied} abort=${!!toolOut.abortLoop} out=${logSnippet(toolOut.output, 120)}`,
  );

  return { replied: toolOut.replied, abortLoop: !!toolOut.abortLoop, output: toolOut.output };
}

/**
 * 主循环用尽轮次或 LLM 无工具返回却仍未 reply 时：禁掉其它工具，强制一轮 reply_to_user。
 */
async function runForcedReplyRecovery(opts: {
  env: InnerLlmEnv;
  ctx: OuterToolContext;
  messages: ConvMessage[];
  config: ConversationLoopConfig;
  callLlm: LlmToolCallFn;
  roundsUsed: number;
  toolsUsed: string[];
  toolResults?: OuterToolResultSnap[];
  replyTexts?: string[];
  lastContent: string | null;
}): Promise<{ replied: boolean; roundsUsed: number; lastContent: string | null }> {
  const { env, ctx, messages, config, callLlm } = opts;
  let roundsUsed = opts.roundsUsed;
  let lastContent = opts.lastContent;
  let replied = false;

  if (ctx.freshCheck) {
    try {
      if (await ctx.freshCheck()) {
        console.log('[utlra][outer-loop] recovery skipped: another agent already replied');
        return { replied: false, roundsUsed, lastContent };
      }
    } catch {
      // 新鲜度检查失败不阻断强制回复
    }
  }

  messages.push({
    role: 'user',
    content:
      '【系统】你已使用多轮工具但仍未向用户发送消息（不允许静默结束）。' +
      '现在**只能**调用 reply_to_user，根据上文已查到的信息用 1–3 句口语回复用户；禁止再调用其他任何工具。',
  });

  console.warn('[utlra][outer-loop] recovery: forcing reply_to_user-only round (other tools disabled)');

  roundsUsed++;
  let resp: LlmToolCallResponse;
  try {
    resp = await callLlm({
      env,
      messages,
      tools: OUTER_REPLY_ONLY_TOOL_DEFS,
      maxTokens: config.maxTokens,
      toolChoice: { type: 'function', function: { name: 'reply_to_user' } },
    });
  } catch (e) {
    console.error('[utlra][outer-loop] recovery LLM call failed', e);
    resp = { content: null, tool_calls: [], raw: {} };
  }

  lastContent = resp.content ?? lastContent;

  if (resp.tool_calls.length) {
    messages.push({
      role: 'assistant',
      content: resp.content ?? null,
      tool_calls: resp.tool_calls,
    });

    for (const tc of resp.tool_calls) {
      if (tc.function.name !== 'reply_to_user') {
        console.warn(`[utlra][outer-loop] recovery ignored disallowed tool=${tc.function.name}`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: '（本轮仅允许 reply_to_user，该工具已拒绝执行）',
        });
        continue;
      }
      const out = await executeReplyToolCall(
        tc,
        roundsUsed,
        ctx,
        opts.toolsUsed,
        opts.toolResults,
        opts.replyTexts,
      );
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: out.output,
      });
      if (out.replied) replied = true;
      if (out.abortLoop) return { replied, roundsUsed, lastContent };
    }
  }

  if (!replied && resp.content?.trim()) {
    const out = await executeReplyToolCall(
      {
        id: `recovery-content-${roundsUsed}`,
        type: 'function',
        function: {
          name: 'reply_to_user',
          arguments: JSON.stringify({ text: resp.content.trim() }),
        },
      },
      roundsUsed,
      ctx,
      opts.toolsUsed,
      opts.toolResults,
      opts.replyTexts,
    );
    if (out.replied) replied = true;
    if (out.abortLoop) return { replied, roundsUsed, lastContent };
  }

  if (!replied) {
    const fallbackText = pickRecoveryFallbackText(lastContent, messages);
    console.warn(
      `[utlra][outer-loop] recovery hard fallback reply_to_user text=${logSnippet(fallbackText, 80)}`,
    );
    const out = await executeReplyToolCall(
      {
        id: `recovery-fallback-${roundsUsed}`,
        type: 'function',
        function: {
          name: 'reply_to_user',
          arguments: JSON.stringify({ text: fallbackText }),
        },
      },
      roundsUsed,
      ctx,
      opts.toolsUsed,
      opts.toolResults,
      opts.replyTexts,
    );
    if (out.replied) replied = true;
  }

  return { replied, roundsUsed, lastContent };
}

/**
 * 口头答应做事却未成功派活：再给一轮完整工具环（非 reply-only）。
 * @see doc/structurizr/IM-INBOUND-INTENT-ROUTING.md §4.2
 */
async function runEmptyPromiseRecovery(opts: {
  env: InnerLlmEnv;
  ctx: OuterToolContext;
  messages: ConvMessage[];
  config: ConversationLoopConfig;
  callLlm: LlmToolCallFn;
  roundsUsed: number;
  toolsUsed: string[];
  toolResults: OuterToolResultSnap[];
  replyTexts: string[];
  lastContent: string | null;
}): Promise<{
  replied: boolean;
  roundsUsed: number;
  lastContent: string | null;
}> {
  const { env, ctx, messages, config, callLlm, toolsUsed, toolResults, replyTexts } = opts;
  let roundsUsed = opts.roundsUsed;
  let lastContent = opts.lastContent;
  let replied = false;

  messages.push({ role: 'user', content: EMPTY_PROMISE_RECOVERY_SYSTEM });
  console.warn('[utlra][outer-loop] empty-promise recovery: forcing one more full tool round');

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
    console.error('[utlra][outer-loop] empty-promise recovery LLM failed', e);
    return { replied: false, roundsUsed, lastContent };
  }

  lastContent = resp.content ?? lastContent;
  if (!resp.tool_calls.length) {
    return { replied: false, roundsUsed, lastContent };
  }

  messages.push({
    role: 'assistant',
    content: resp.content ?? null,
    tool_calls: resp.tool_calls,
  });

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
    toolResults.push({ name: tc.function.name, output: toolOut.output });
    if (tc.function.name === 'reply_to_user') {
      const text = extractReplyTextFromArgs(tc.function.arguments);
      if (text) replyTexts.push(text);
    }
    if (toolOut.replied) replied = true;

    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: toolOut.output,
    });

    console.log(
      `[utlra][outer-loop] empty-promise round ${roundsUsed} tool=${tc.function.name} ok=${ok} out=${logSnippet(toolOut.output, 120)}`,
    );

    if (toolOut.abortLoop) break;
  }

  return { replied, roundsUsed, lastContent };
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
  const nowTag = formatAgentNowTag();

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
  const toolResults: OuterToolResultSnap[] = [];
  const replyTexts: string[] = [];
  let abortedByFreshCheck = false;

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
            replyTexts.push(resp.content.trim());
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
      toolResults.push({ name: tc.function.name, output: toolOut.output });
      if (tc.function.name === 'reply_to_user') {
        const text = extractReplyTextFromArgs(tc.function.arguments);
        if (text) replyTexts.push(text);
      }
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
      abortedByFreshCheck = true;
      break;
    }

    // 如果已回复且没有强制继续的工具，可以提前终止
    if (replied && resp.tool_calls.every((tc) => tc.function.name === 'reply_to_user')) {
      break;
    }
  }

  let forcedReplyRecovery = false;
  if (!replied && !abortedByFreshCheck) {
    forcedReplyRecovery = true;
    const recovered = await runForcedReplyRecovery({
      env,
      ctx,
      messages,
      config,
      callLlm,
      roundsUsed,
      toolsUsed,
      toolResults,
      replyTexts,
      lastContent,
    });
    replied = recovered.replied;
    roundsUsed = recovered.roundsUsed;
    lastContent = recovered.lastContent;
  }

  let emptyPromiseRecovery = false;
  if (
    !abortedByFreshCheck &&
    shouldReconcileEmptyPromise({ userMessage, replyTexts, toolResults })
  ) {
    emptyPromiseRecovery = true;
    const recovered = await runEmptyPromiseRecovery({
      env,
      ctx,
      messages,
      config,
      callLlm,
      roundsUsed,
      toolsUsed,
      toolResults,
      replyTexts,
      lastContent,
    });
    if (recovered.replied) replied = true;
    roundsUsed = recovered.roundsUsed;
    lastContent = recovered.lastContent;
  }

  const toolsChain = toolsUsed.length ? toolsUsed.join('→') : '(none)';
  console.log(
    `[utlra][outer-loop] done: replied=${replied} rounds=${roundsUsed} tools=${toolsChain}` +
      `${forcedReplyRecovery ? ' recovery=1' : ''}` +
      `${emptyPromiseRecovery ? ' emptyPromise=1' : ''}` +
      `${!replied ? ` lastContent=${logSnippet(lastContent)}` : ''}`,
  );

  return {
    replied,
    roundsUsed,
    lastContent,
    toolsUsed,
    forcedReplyRecovery,
    emptyPromiseRecovery,
  };
}
