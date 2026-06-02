/**
 * 外脑定时心跳（OuterHeartbeat）。
 *
 * 心跳是外脑的自主循环，独立于消息触发。
 * 每隔固定间隔，LLM 以"自我反思/规划"模式运行一次，根据长期目标决定是否需要主动行动。
 *
 * 可用工具：
 *   - post_to_im       → 主动向 IM 线程发消息（有实质内容时才用）
 *   - set_goal         → 向内脑派发任务
 *   - read_inner_status → 观察内脑当前状态
 *
 * 环境变量（统一经 `loadHeartbeatConfigFromEnv()` 收口，见 doc/testing-strategy.md §S1）：
 *   UTLRA_OUTER_HEARTBEAT_INTERVAL_MS    心跳间隔（ms），默认 300_000（5分钟）
 *   UTLRA_OUTER_HEARTBEAT_ENABLED        false 可关闭心跳
 *   UTLRA_OUTER_HEARTBEAT_THREAD_ID      主动发消息时的默认目标线程（可选）
 *   UTLRA_AGENT_NAME                     心跳与对话回复使用的 agent 显示名
 */
import type {
  FilesystemRepositoryStore,
  FilesystemWorkspaceStore,
  InnerBrainEngine,
} from '../workspace-kit/index.js';
import type { ChatAssetStore, ChatIRChannel } from '@utlra/chat-ir';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { llmRawChatCompletion } from '../llm/raw.js';
import { executeOuterTool, resolveAgentSid, resolveWorkspaceId } from './outer-tools.js';
import type { OuterToolContext, ToolDef } from './outer-tools.js';
import { isSetGoalDispatched } from './inner-brain-kpi-reuse.js';
import { loadSoul } from './soul.js';
import { loadOuterGoal, ensureOuterGoalFile } from './outer-goal.js';
import type { OuterMemoryStore } from './outer-memory.js';
import type { LogEntry } from './outer-brain.js';
import { formatAgentIsoLocal, formatAgentLocalDateTime, resolveAgentTimezone } from '../agent-time.js';
import type { KpiRegistry } from './kpi-registry.js';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import { PerformanceGoalEngine } from '../performance-goals/engine.js';
import { OUTER_ASYNC_ORCHESTRATION_GUIDE, buildBrainAsyncSnapshot } from './brain-async-snapshot.js';
import { runAutonomyPipeline } from './autonomy-pipeline.js';
import type { ResourceProbeDeps } from './resource-probe.js';
import { OUTER_TOOL_DEFS } from './outer-tools.js';
import {
  formatKpiCompletionBlock,
  sweepKpiCompletions,
} from './kpi-completion-judge.js';
import { formatRecentThreadMessagesForLlm } from './thread-history.js';
import type { IdentityRegistry, LooseThreadStore } from '@utlra/chat-ir';

// ── 配置（统一经 loadHeartbeatConfigFromEnv() 解析，唯一的 env 读取点） ──────

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

export interface HeartbeatConfig {
  /** Agent 显示名（缺省 Kuroneko） */
  agentName: string;
  /** 是否启用心跳（缺省 true；env=false 关闭） */
  enabled: boolean;
  /** 心跳间隔（ms） */
  intervalMs: number;
  /** 主动发消息的默认目标线程；空字符串 = 未配置 */
  defaultThreadId: string;
}

import { resolveDefaultImThreadId } from './default-im-thread.js';

function resolveHeartbeatDefaultThreadId(env: NodeJS.ProcessEnv): string {
  return resolveDefaultImThreadId(env);
}

export function loadHeartbeatConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HeartbeatConfig {
  const intervalRaw = env['UTLRA_OUTER_HEARTBEAT_INTERVAL_MS'];
  const intervalMs = intervalRaw === undefined ? DEFAULT_INTERVAL_MS : Number(intervalRaw);
  return {
    agentName: env['UTLRA_AGENT_NAME']?.trim() || 'Kuroneko',
    enabled: env['UTLRA_OUTER_HEARTBEAT_ENABLED'] !== 'false',
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS,
    defaultThreadId: resolveHeartbeatDefaultThreadId(env),
  };
}

// ── 心跳专用工具集 ────────────────────────────────────────────────────────────

const HEARTBEAT_KPI_TOOL_NAMES = ['list_kpis', 'view_kpi', 'achieve_kpi'] as const;

function buildHeartbeatToolDefs(hasImClient: boolean): ToolDef[] {
  const tools: ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'read_inner_status',
        description:
          '查询内脑状态（含 async：is_async_waiting、next_wake_at、active_pendings、is_post_complete）。',
        parameters: {
          type: 'object',
          properties: {
            workspace_id: {
              type: 'string',
              description: '工作区 ID，默认 "default"',
            },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_goal',
        description:
          '向内脑派发任务（**每次新建 instance**）。周期/监督类 KPI 只派一次，勿重复「第 N 轮」。' +
          '派发前 read_inner_status 确认无 is_async_waiting。',
        parameters: {
          type: 'object',
          properties: {
            goal: {
              type: 'string',
              description: '任务目标描述（Markdown），内脑将根据此目标执行',
            },
            workspace_id: {
              type: 'string',
              description: '工作区 ID，默认 "default"',
            },
            performance_goal_id: {
              type: 'string',
              description: '若此动作是为了推进某个绩效目标，请填写该 goal_id',
            },
          },
          required: ['goal'],
        },
      },
    },
  ];

  for (const name of HEARTBEAT_KPI_TOOL_NAMES) {
    const def = OUTER_TOOL_DEFS.find((t) => t.function.name === name);
    if (def) tools.push(def);
  }

  tools.unshift({
    type: 'function',
    function: {
      name: 'list_inner_brains',
      description:
        '列出**所有**内脑任务实例（跨 workspace）。含 registry_status、阶段、里程碑，' +
        '以及 async 字段（is_async_waiting、next_wake_at、active_pendings、is_post_complete）。' +
        '心跳判断「是否还有任务在跑 / 是否需要派新任务」时**必须先调用本工具**，' +
        '不要只看 default workspace 的状态。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  });

  if (hasImClient) {
    tools.unshift({
      type: 'function',
      function: {
        name: 'post_to_im',
        description:
          '主动向 IM 线程发送一条消息。' +
          '仅在与**本 agent 自己的 KPI/在途任务**直接相关时使用：完成汇报、硬阻塞需用户决策、本 KPI 关键进展。' +
          '禁止替其他 agent 传话、汇总他人进度、对群聊里别人的任务插嘴。' +
          '必须紧扣当前 IM 最近内容；无实质价值则不要发。',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: '消息内容，简短（1-2句话），有实质价值',
            },
            thread_id: {
              type: 'string',
              description:
                '目标线程 ID。可填写已知的线程 ID；留空则使用默认心跳线程（若已配置）。',
            },
            performance_goal_id: {
              type: 'string',
              description: '若此动作是为了推进某个绩效目标，请填写该 goal_id',
            },
          },
          required: ['text'],
        },
      },
    });
  }

  return tools;
}

// ── LLM 调用 ──────────────────────────────────────────────────────────────────

interface ToolCallEntry {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type ConvMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallEntry[] }
  | { role: 'tool'; tool_call_id: string; content: string };

async function callLlmWithTools(
  env: InnerLlmEnv,
  messages: ConvMessage[],
  tools: ToolDef[],
): Promise<{ content: string | null; tool_calls: ToolCallEntry[] }> {
  const { raw } = await llmRawChatCompletion<{
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: ToolCallEntry[] };
    }>;
    error?: { message?: string };
  }>({
    provider: env.provider,
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    usageMeta: { source: 'outer_heartbeat', model: env.textModel, provider: env.provider },
    body: {
      temperature: 0.5,
      thinking: { type: 'disabled' },
      tools,
      tool_choice: 'auto',
    },
  });

  const msg = raw.choices?.[0]?.message;
  return { content: msg?.content ?? null, tool_calls: msg?.tool_calls ?? [] };
}

// ── 跨 workspace 在途任务汇总（避免心跳只看 default workspace 误判） ──────────

/**
 * 汇总 registry 中所有「占用推进槽位」的 burst（RUNNING/AWAITING/BLOCKED），
 * 供心跳上下文注入。心跳此前只读 default workspace status，多内脑场景下会把
 * 实际在跑的 burst 误判为「无任务」。
 */
function buildLiveBurstSummary(registry: InnerBrainRegistry | undefined): string {
  if (!registry) return '（多内脑注册表未启用）';
  const live = registry
    .list()
    .filter((t) => t.status === 'RUNNING' || t.status === 'AWAITING' || t.status === 'BLOCKED');
  if (live.length === 0) {
    return '当前没有任何在途 burst（RUNNING/AWAITING/BLOCKED 均为 0）。';
  }
  const lines = live.map((t) => {
    let asyncPart = '';
    try {
      const snap = buildBrainAsyncSnapshot(t.workDir);
      asyncPart =
        ` async_waiting=${snap.is_async_waiting}` +
        ` post_complete=${snap.is_post_complete}` +
        (snap.next_wake_at ? ` next_wake=${formatAgentIsoLocal(snap.next_wake_at)}` : '') +
        (snap.active_pendings?.length ? ` pendings=${snap.active_pendings.length}` : '');
    } catch {
      asyncPart = ' async=未知';
    }
    return (
      `- ${t.instanceId} [${t.status}]` +
      (t.kpiId ? ` kpi=${t.kpiId}` : '') +
      ` started=${formatAgentIsoLocal(t.startedAt)}` +
      ` deliverables=${t.deliverableCount ?? 0}` +
      ` ticks=${t.ticks ?? 0}` +
      asyncPart +
      `\n  goal: ${t.goal.replace(/\s+/g, ' ').slice(0, 80)}`
    );
  });
  return `当前在途 burst ${live.length} 个：\n${lines.join('\n')}`;
}

// ── 心跳系统提示 ──────────────────────────────────────────────────────────────

function buildHeartbeatSystemPrompt(
  agentName: string,
  soul: string,
  longTermGoal: string,
  hasImCapability: boolean,
): string {
  const imSection = hasImCapability
    ? `- post_to_im：主动发 IM（仅本 agent KPI/任务相关，禁止管别人闲事）`
    : `- （当前无 IM 发送能力，UTLRA_OUTER_HEARTBEAT_THREAD_ID 未配置）`;

  const goalSection = longTermGoal
    ? `# 长期目标\n${longTermGoal}`
    : `# 长期目标\n（未设置。你可以在 DATA_ROOT/outer/goal.md 中定义长期目标来指导心跳行为。）`;

  return `你是 ${agentName}，现在进行定时自主规划（心跳模式）。

# 灵魂设定
${soul}

${goalSection}

## 宏观战略（WHY + HOW，不可被质控替代）
- **先 WHY**：对照长期目标与 KPI，这些方向**还值不值得推**？reflexion/lesson 是否推翻原有假设？若不值得 → 暂停或换 KPI，不要硬派 set_goal。
- **再 HOW**：在 WHY 成立前提下，下一 burst **什么角度**、优先级如何；避免无记忆的「每 tick 随机挑一条 KPI」。
- P1 起读 \`strategy/current.json\`（theory / whyNow / focusOrder）；未落地前由本心跳承担同等 WHY+HOW 思考，**不能**只做 liveness/deliverable 战术判断。
- 跨 KPI 取舍、AWAITING 战略 cull 属战略层（见 STRATEGY-PLANNING-LAYER）；下文质控只管**在途 burst 做得怎样**。

## 质控职责（战术层，与战略并列）
- **KPI 完成判定**：每 tick 先核对 active KPI 是否应 achieved（list_kpis / view_kpi 看建议动作）。程序化 sweep 可能已自动结案；若 digest 建议 achieved 但仍 active → achieve_kpi（附 evidence）。**不要**对已 achieved KPI 再 set_goal。
- **验收内脑效果**：用 list_inner_brains / read_inner_status 看 deliverables、ticks、reflexion 是否在向 KPI **实质靠近**；勿因单 tick 产出少就判失败（内脑可能是增量靠近）。
- **卡死与重启把控**：区分 AWAITING 正常等待 vs RUNNING 长期无 tick（liveness=stuck）/ pid dead；idle streak 无产出时优先反思 burst，真 stuck 才考虑 directive 或告知人类需 /restart。
- **方向干预**：效果不对 → 换角度 set_goal 或触发反思；不要替内脑完成 milestone 级验收（那是 Attributor 的事）。

## 职责边界
- **只管自己的事**：优先推进**本 agent 绑定的 KPI / 在途 burst / 长期目标**。
- **不要当群管家**：不替 Kuroneko/Gin/Shiro/Aoi 盯进度、不汇总他人任务、不帮别人派 set_goal、不对别人的 blocker 主动插嘴。
- 群聊里在讨论**别人的**小说/空投/内脑/VPS 等，与你 KPI 无关时 → **不要 post_to_im**，本轮保持沉默即可。
- 只有人类 **@你**、或阻塞**你自己的** KPI/内脑、或**你自己的**任务完成需汇报时，才考虑发消息。

## 接话判定（必须回复）
满足以下**任一条**就必须接话（post_to_im 或响应），不可因「别人也在聊别的」而沉默：
1. **在询问你**：@你、口头点名你、或明显等你回答。
2. **与你的 KPI 有关**：话题涉及你正在推进的 KPI 目标、交付、进度或 blocker。
3. **只有你能答**：问题指向只有你掌握的信息（你的内脑状态、你负责的任务/部署/改动）。

## 心跳模式说明
你不是在回应某人，而是在进行定期的**战略自检（WHY+HOW）**与**在途质控**。
对照**自己的**长期目标与 KPI：先判断方向是否仍对，再判断是否需要派活或干预。

## 可用工具
${imSection}
- set_goal：向内脑派发任务（仅推进**本 agent** 目标，勿替他人派活）
- list_inner_brains：列出**所有** workspace 的内脑实例（判断任务状态的**唯一权威来源**）
- read_inner_status：查询**单个** workspace 的内脑状态（只反映该 workspace，**不要**用它判断「有没有任务在跑」）

## 状态判断原则（重要，先读再判断）
1. **先调 list_inner_brains 看全量在途任务**。上方「在途任务」已给出汇总，但行动前应再确认。
2. **只关心与本 agent 相关的 burst**（goal/kpi 属于你在推进的目标）。别人在跑的内脑，默认不管。
3. **正确理解状态**，不要把「在跑」误判为「无产出该停掉」：
   - RUNNING = 正在干活，**让它继续**，绝不要因为「还没出结果」就 stop。
   - AWAITING + is_async_waiting=true = 在等定时/外部事件，**正常**，不要 stop、不要催。
   - AWAITING 但无 next_wake_at 且 active_pendings 为空 = 可能真卡住，才考虑处理。
   - is_post_complete=true = 已完成收尾，不要再 set_goal 同一任务。
4. **不要为了「确认要不要继续」而向用户提问**。任务在正常推进时，用户无需被打扰。

## 行动原则（KPI 优先，而非到处参与）
1. **KPI 全力冲刺**：同 KPI 已有 RUNNING/AWAITING/BLOCKED 在途 burst 时 → **禁止** set_goal 再派并行 burst，让当前 burst 跑完；本轮保持沉默即可。
2. **KPI 续派**：仅当该 KPI **无**在途 burst（上一 burst 已结束）且槽位未满时，才 set_goal 推进下一角度。
3. **避免重复**：派新任务前对照「在途任务」的 goal，新任务必须是**不同的子方向/角度**。
4. **post_to_im 仅用于**：**你自己的**任务完成汇报、**你自己的**硬阻塞（缺凭据/需授权）、**与你 KPI 直接相关**的关键信息。
   **禁止**：替他人传 cookie/文件、催别人进度、对无关群聊接话、问「要不要继续」。
   发消息前必须阅读「当前 IM 对话」：仅在与**你**相关时接话，否则不发。
5. **克制**：内脑已在等定时（is_async_waiting）或已完成（is_post_complete）时 **不要** set_goal 同一任务。
6. **每次最多**：发 1 条 IM 消息，创建 1 个内脑任务。
7. **关联绩效目标**：推进绩效目标时把 goal_id 填入 performance_goal_id。

${OUTER_ASYNC_ORCHESTRATION_GUIDE}`;
}

// ── 心跳执行逻辑 ──────────────────────────────────────────────────────────────

const HEARTBEAT_MAX_ROUNDS = 6;

function readPerformanceGoalId(argsJson: string): string | null {
  try {
    const parsed = JSON.parse(argsJson) as { performance_goal_id?: unknown };
    const raw = typeof parsed.performance_goal_id === 'string' ? parsed.performance_goal_id.trim() : '';
    return raw || null;
  } catch {
    return null;
  }
}

function classifyGoalActionStatus(
  actionName: 'post_to_im' | 'set_goal',
  result: string,
): 'success' | 'failed' | 'skipped' {
  if (actionName === 'post_to_im') {
    if (result.startsWith('已发送 IM 消息')) return 'success';
    if (result.startsWith('IM 发送失败') || result.startsWith('工具执行错误')) return 'failed';
    return 'skipped';
  }

  if (isSetGoalDispatched(result)) return 'success';
  if (result.startsWith('工具执行错误')) return 'failed';
  return 'skipped';
}

async function runHeartbeat(
  env: InnerLlmEnv,
  ctx: OuterToolContext,
  soul: string,
  longTermGoal: string,
  imClient: ChatIRChannel | null,
  performanceEngine: PerformanceGoalEngine,
  config: HeartbeatConfig,
  performanceBlock?: string,
  threadContext?: { threadId: string; text: string },
): Promise<void> {
  const { agentName, defaultThreadId } = config;
  const hasImCapability = !!imClient;
  const toolDefs = buildHeartbeatToolDefs(hasImCapability);

  const systemPrompt = buildHeartbeatSystemPrompt(agentName, soul, longTermGoal, hasImCapability);

  // 读取内脑状态作为心跳触发时的初始上下文
  let innerStatusText = '（内脑状态未知）';
  try {
    const status = ctx.getEngine(ctx.workspaceId).readStatus();
    if (status) {
      innerStatusText = [
        `阶段：${status.phase ?? '未知'}`,
        `目标摘要：${status.goalSummary?.slice(0, 300) ?? '无'}`,
        `最近动作：${status.lastAction ?? '—'}`,
        `错误：${status.lastError ?? '无'}`,
      ].join('\n');
    } else {
      innerStatusText = '内脑尚未启动（无 status.json）';
    }
  } catch {
    innerStatusText = '无法读取内脑状态';
  }

  // 跨 workspace 在途任务汇总（权威来源，优先于 default workspace 单点状态）
  const liveBurstSummary = buildLiveBurstSummary(ctx.innerBrainRegistry);

  const kpiCompletionBlock =
    ctx.kpiRegistry && ctx.innerBrainRegistry
      ? formatKpiCompletionBlock(ctx.kpiRegistry, ctx.innerBrainRegistry)
      : '';

  // 读取记忆层（daily-log + tasks）注入心跳上下文
  const memStore = ctx.memoryStore;
  const memory   = memStore ? await memStore.readMemoryContext() : { dailyLog: '', tasks: '', hasAny: false };
  const memSection = memStore ? memStore.formatMemoryForLlm(memory) : '';

  const threadSection =
    threadContext?.text.trim()
      ? `\n## 当前 IM 对话（${threadContext.threadId}）\n${threadContext.text}\n`
      : '';

  const userContent = `当前时间：${formatAgentLocalDateTime(new Date(), resolveAgentTimezone())}
${threadSection}
## 在途任务（跨所有 workspace，权威来源）
${liveBurstSummary}
${kpiCompletionBlock ? `\n${kpiCompletionBlock}\n` : ''}

## default workspace 状态（仅供参考，不代表全部任务）
${innerStatusText}
${memSection ? `\n${memSection}\n` : ''}
${performanceBlock ? `\n${performanceBlock}\n` : ''}
请对照**你自己的**长期目标、KPI 与在途 burst${threadSection ? '，以及当前 IM 对话（仅在与你相关时接话）' : ''}，判断现在是否需要主动行动。与别人 KPI 无关时不要 post_to_im。`;

  const messages: ConvMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  let imSent = 0;
  let goalCreated = 0;

  for (let round = 0; round < HEARTBEAT_MAX_ROUNDS; round++) {
    let resp: { content: string | null; tool_calls: ToolCallEntry[] };
    try {
      resp = await callLlmWithTools(env, messages, toolDefs);
    } catch (e) {
      console.error('[utlra][heartbeat] LLM call failed', e);
      break;
    }

    if (!resp.tool_calls.length) {
      if (resp.content?.trim()) {
        console.log(`[utlra][heartbeat] decision: ${resp.content.trim().slice(0, 300)}`);
      }
      break;
    }

    messages.push({
      role: 'assistant',
      content: resp.content ?? null,
      tool_calls: resp.tool_calls,
    });

    for (const tc of resp.tool_calls) {
      let result: string;
      const performanceGoalId = readPerformanceGoalId(tc.function.arguments);

      if (tc.function.name === 'post_to_im') {
        result = await execPostToIm(tc.function.arguments, imClient, ctx.agentSid, defaultThreadId, imSent);
        if (!result.startsWith('（已达')) imSent++;
        if (performanceGoalId) {
          performanceEngine.recordActionOutcome(
            performanceGoalId,
            'post_message',
            classifyGoalActionStatus('post_to_im', result),
            result,
          );
        }
      } else if (tc.function.name === 'set_goal') {
        if (goalCreated >= 1) {
          result = '（已达到本次心跳任务上限，任务未创建）';
        } else {
          try {
            const toolOut = await executeOuterTool(tc.function.name, tc.function.arguments, ctx);
            result = toolOut.output;
            goalCreated++;
          } catch (e) {
            result = `工具执行错误：${e instanceof Error ? e.message : String(e)}`;
          }
        }
        if (performanceGoalId) {
          performanceEngine.recordActionOutcome(
            performanceGoalId,
            'set_goal',
            classifyGoalActionStatus('set_goal', result),
            result,
          );
        }
      } else {
        // read_inner_status 等
        try {
          const toolOut = await executeOuterTool(tc.function.name, tc.function.arguments, ctx);
          result = toolOut.output;
        } catch (e) {
          result = `工具执行错误：${e instanceof Error ? e.message : String(e)}`;
        }
      }

      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
}

async function execPostToIm(
  argsJson: string,
  imClient: ChatIRChannel | null,
  agentSid: string,
  defaultThreadId: string,
  alreadySent: number,
): Promise<string> {
  if (alreadySent >= 1) {
    return '（已达到本次心跳 IM 消息上限，消息未发送）';
  }
  if (!imClient) {
    return '（无 IM 客户端，消息未发送）';
  }

  let args: { text?: string; thread_id?: string };
  try {
    args = JSON.parse(argsJson) as { text?: string; thread_id?: string };
  } catch {
    args = {};
  }

  const text = args.text?.trim() ?? '';
  if (!text) return '（消息内容为空，未发送）';

  const threadId = args.thread_id?.trim() || defaultThreadId;
  if (!threadId) {
    return '（未指定 thread_id 且未配置 UTLRA_OUTER_HEARTBEAT_THREAD_ID，消息未发送。请在工具调用时提供 thread_id，或在环境变量中配置默认线程）';
  }

  try {
    await imClient.postMessage(threadId, {
      sender_sid: agentSid,
      text,
      parse_mentions: true,
    });
    console.log(`[utlra][heartbeat] post_to_im → ${threadId}: ${text.slice(0, 80)}`);
    return `已发送 IM 消息至 ${threadId}（${text.length} 字符）`;
  } catch (e) {
    return `IM 发送失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── OuterHeartbeat 类 ─────────────────────────────────────────────────────────

export interface HeartbeatDeps {
  getEngine: (workspaceId: string) => InnerBrainEngine;
  workspaceStore: FilesystemWorkspaceStore;
  repoStore: FilesystemRepositoryStore;
  dataRoot: string;
  repoRoot?: string;
  getLlmEnv: () => InnerLlmEnv | null;
  /** IM 客户端（用于主动发消息）。传 null 表示心跳无 IM 发送能力。 */
  imClient: ChatIRChannel | null;
  /**
   * Chat IR 资产仓库。心跳工具集默认不调 reply_to_user / send_file，
   * 但 OuterToolContext 要求此字段必填，需要保持注入。
   */
  assetStore: ChatAssetStore;
  /** 外脑记忆层（可选，传入时心跳上下文包含记忆） */
  memoryStore?: OuterMemoryStore;
  /** 多内脑注册表（autonomy dispatch set_goal 必需） */
  innerBrainRegistry?: InnerBrainRegistry;
  /** KPI 注册表（autonomy kpi_inner_goal 必需） */
  kpiRegistry?: KpiRegistry;
  scheduleReflexionBurst?: (kpiId: string) => string | null;
  scheduleNextKpiBurst?: (kpiId: string) => string | null;
  getOrchestratorStats?: ResourceProbeDeps['getOrchestratorStats'];
  /**
   * 外脑实例引用（可选，传入时启用 Environment 侧死亡检测）。
   * 心跳 tick 通过 outerBrain.getRecentActions() 获取行为日志快照，
   * 比对连续无变化次数来判定是否卡死。
   */
  outerBrain?: { getRecentActions(limit?: number): LogEntry[] };
  /**
   * 死亡检测阈值：连续多少次 tick 无变化后判定卡死。默认 3。
   * 仅在 outerBrain 已注入时生效。
   */
  deathDetectionThreshold?: number;
  /**
   * 心跳运行参数。缺省一次性从 env 解析（`loadHeartbeatConfigFromEnv`）。
   * 测试时显式注入即可绕开 env，且 enabled/intervalMs/agentName 均可控制。
   */
  config?: HeartbeatConfig;
  loadThreads?: () => LooseThreadStore;
  identityRegistry?: IdentityRegistry;
}

export class OuterHeartbeat {
  private deps: HeartbeatDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly performanceEngine: PerformanceGoalEngine;
  private readonly config: HeartbeatConfig;

  // ── 死亡检测内部状态 ──
  /** 上次快照的 stateHash（基于行为日志长度 + 最后一条日志摘要） */
  private _lastStateHash = '';
  /** 连续无变化计数 */
  private _missedCount = 0;
  /** 死亡检测阈值（从 deps 读取，默认 3） */
  private readonly _deathThreshold: number;

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
    this.config = deps.config ?? loadHeartbeatConfigFromEnv();
    ensureOuterGoalFile(deps.dataRoot, this.config.agentName);
    this.performanceEngine = new PerformanceGoalEngine(deps.dataRoot);
    this._deathThreshold = deps.deathDetectionThreshold ?? 3;
  }

  start(): void {
    if (!this.config.enabled) {
      console.log('[utlra][heartbeat] disabled via UTLRA_OUTER_HEARTBEAT_ENABLED=false');
      return;
    }

    console.log(`[utlra][heartbeat] starting, interval=${this.config.intervalMs}ms`);

    this.timer = setInterval(() => {
      void this._tick();
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 立即触发一次心跳（测试/手动触发用） */
  async triggerNow(): Promise<void> {
    await this._tick();
  }

  // ── Environment 侧死亡检测 ────────────────────────────────────────

  /**
   * 基于行为日志快照计算 stateHash。
   *
   * 算法（对齐 skill-0f2f）：
   *   stateHash = logEntries.length + ":" + lastEntry.timestamp + ":" + lastEntry.operation_type
   *
   * 若日志为空（如 agent 尚未 born），返回空串。
   */
  private _computeStateHash(actions: LogEntry[]): string {
    if (actions.length === 0) return '';
    // actions 是降序排列的（getRecentActions 返回降序），取第一条即最新
    const latest = actions[0];
    return `${actions.length}:${latest.timestamp}:${latest.operation_type}`;
  }

  /**
   * 执行一次死亡检测。
   *
   * 流程（对齐 skill-0f2f）：
   *   1. 获取 getRecentActions() 快照
   *   2. 计算 stateHash
   *   3. 与 lastStateHash 比对
   *      - 相同 → missedCount++
   *      - 不同 → missedCount 归零，更新 lastStateHash
   *   4. missedCount >= deathThreshold → 输出卡死警告（console.error）
   *
   * 注意：仅输出警告，不执行任何终止或重启操作。
   */
  private _checkAlive(): void {
    if (!this.deps.outerBrain) return;

    const actions = this.deps.outerBrain.getRecentActions();
    const currentHash = this._computeStateHash(actions);

    if (currentHash === this._lastStateHash) {
      this._missedCount++;
      if (this._missedCount >= this._deathThreshold) {
        console.error(
          `[utlra][heartbeat][DEATH-DETECT] Agent appears stuck! ` +
          `missedCount=${this._missedCount} threshold=${this._deathThreshold} ` +
          `lastStateHash=${this._lastStateHash || '(empty)'} ` +
          `No behavior change detected for ${this._missedCount} consecutive ticks.`,
        );
      } else {
        console.warn(
          `[utlra][heartbeat][DEATH-DETECT] No behavior change ` +
          `(missedCount=${this._missedCount}/${this._deathThreshold})`,
        );
      }
    } else {
      if (this._missedCount > 0) {
        console.log(
          `[utlra][heartbeat][DEATH-DETECT] Behavior resumed after ${this._missedCount} stagnant tick(s). Resetting.`,
        );
      }
      this._missedCount = 0;
      this._lastStateHash = currentHash;
    }
  }

  /**
   * 获取当前死亡检测状态（供外部观测使用）
   */
  getDeathDetectionStatus(): { missedCount: number; threshold: number; lastStateHash: string; isStuck: boolean } {
    return {
      missedCount: this._missedCount,
      threshold: this._deathThreshold,
      lastStateHash: this._lastStateHash,
      isStuck: this._missedCount >= this._deathThreshold,
    };
  }

  private async _tick(): Promise<void> {
    // 执行死亡检测（在 LLM tick 之前，基于上一次 tick 以来的行为变化判断）
    this._checkAlive();

    // KPI 完成判定 sweep（在派活之前结案，避免对已达成 KPI 误派）
    if (this.deps.kpiRegistry && this.deps.innerBrainRegistry) {
      const completion = sweepKpiCompletions(
        this.deps.kpiRegistry,
        this.deps.innerBrainRegistry,
      );
      if (completion.marked.length > 0) {
        console.log(
          `[utlra][heartbeat][kpi-complete] marked achieved: ${completion.marked.join(', ')}`,
        );
      }
      for (const p of completion.pending) {
        console.log(
          `[utlra][heartbeat][kpi-complete] pending ${p.kpiId}: ${p.reason}`,
        );
      }
    }

    if (this.running) {
      console.log('[utlra][heartbeat] previous tick still running, skipping');
      return;
    }

    const env = this.deps.getLlmEnv();
    if (!env) {
      console.log('[utlra][heartbeat] no LLM env, skipping tick');
      return;
    }

    this.running = true;
    console.log('[utlra][heartbeat] tick start');

    try {
      const agentSid = resolveAgentSid();
      const workspaceId = resolveWorkspaceId();

      // ── P0 autonomy：probe → hard gates → KPI/闲聊 dispatch ─────────────
      if (this.deps.innerBrainRegistry && this.deps.kpiRegistry) {
        const autonomy = await runAutonomyPipeline({
          dataRoot: this.deps.dataRoot,
          repoRoot: this.deps.repoRoot,
          agentSid,
          workspaceId,
          defaultThreadId: this.config.defaultThreadId,
          registry: this.deps.innerBrainRegistry,
          kpiRegistry: this.deps.kpiRegistry,
          imClient: this.deps.imClient,
          assetStore: this.deps.assetStore,
          getEngine: this.deps.getEngine,
          workspaceStore: this.deps.workspaceStore,
          repoStore: this.deps.repoStore,
          memoryStore: this.deps.memoryStore,
          getLlmEnv: this.deps.getLlmEnv,
          getOrchestratorStats: this.deps.getOrchestratorStats,
          scheduleReflexionBurst: this.deps.scheduleReflexionBurst,
          scheduleNextKpiBurst: this.deps.scheduleNextKpiBurst,
          loadThreads: this.deps.loadThreads,
          identityRegistry: this.deps.identityRegistry,
        });

        if (autonomy.skippedLegacyHeartbeat) {
          console.log('[utlra][heartbeat] tick done (autonomy dispatched, legacy LLM skipped)');
          return;
        }
      }

      // ── Legacy LLM 心跳（autonomy 未 dispatch 时 fallback） ───────────────
      // 热更新：每次 tick 重新读取 soul 和 long-term goal
      const soul = loadSoul(this.deps.dataRoot);
      const longTermGoal = loadOuterGoal(this.deps.dataRoot);
      const performanceBlock = await this.performanceEngine.reviewGoalsForHeartbeat(
        env,
        this.deps.memoryStore,
      );

      const ctx: OuterToolContext = {
        threadId: this.config.defaultThreadId,
        agentSid,
        workspaceId,
        repoRoot: this.deps.repoRoot,
        // 心跳对 imClient 的访问只通过 post_to_im 工具（由 execPostToIm 处理），
        // executeOuterTool 内的 reply_to_user 不会在心跳中被调用（工具集不含它）。
        imClient: this.deps.imClient as never,
        assetStore: this.deps.assetStore,
        getEngine: this.deps.getEngine,
        workspaceStore: this.deps.workspaceStore,
        repoStore: this.deps.repoStore,
        dataRoot: this.deps.dataRoot,
        memoryStore: this.deps.memoryStore,
        innerBrainRegistry: this.deps.innerBrainRegistry,
        kpiRegistry: this.deps.kpiRegistry,
        scheduleReflexionBurst: this.deps.scheduleReflexionBurst,
        scheduleNextKpiBurst: this.deps.scheduleNextKpiBurst,
      };

      this.deps.workspaceStore.ensureWorkspace(workspaceId);

      let threadContext: { threadId: string; text: string } | undefined;
      const hbThreadId = this.config.defaultThreadId.trim();
      if (hbThreadId && this.deps.loadThreads && this.deps.identityRegistry) {
        const recent = formatRecentThreadMessagesForLlm(
          hbThreadId,
          this.deps.loadThreads,
          this.deps.identityRegistry,
        );
        if (recent.text) {
          threadContext = { threadId: hbThreadId, text: recent.text };
        }
      }

      await runHeartbeat(
        env,
        ctx,
        soul,
        longTermGoal,
        this.deps.imClient,
        this.performanceEngine,
        this.config,
        performanceBlock,
        threadContext,
      );
      console.log('[utlra][heartbeat] tick done');
    } catch (e) {
      console.error('[utlra][heartbeat] tick error', e);
    } finally {
      this.running = false;
    }
  }
}
