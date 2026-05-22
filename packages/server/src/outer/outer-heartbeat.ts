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
import { loadSoul } from './soul.js';
import { loadOuterGoal, ensureOuterGoalFile } from './outer-goal.js';
import type { OuterMemoryStore } from './outer-memory.js';
import type { LogEntry } from './outer-brain.js';
import { PerformanceGoalEngine } from '../performance-goals/engine.js';
import { OUTER_ASYNC_ORCHESTRATION_GUIDE } from './brain-async-snapshot.js';

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

export function loadHeartbeatConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HeartbeatConfig {
  const intervalRaw = env['UTLRA_OUTER_HEARTBEAT_INTERVAL_MS'];
  const intervalMs = intervalRaw === undefined ? DEFAULT_INTERVAL_MS : Number(intervalRaw);
  return {
    agentName: env['UTLRA_AGENT_NAME']?.trim() || 'Kuroneko',
    enabled: env['UTLRA_OUTER_HEARTBEAT_ENABLED'] !== 'false',
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS,
    defaultThreadId: env['UTLRA_OUTER_HEARTBEAT_THREAD_ID']?.trim() || '',
  };
}

// ── 心跳专用工具集 ────────────────────────────────────────────────────────────

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

  if (hasImClient) {
    tools.unshift({
      type: 'function',
      function: {
        name: 'post_to_im',
        description:
          '主动向 IM 线程发送一条消息。' +
          '只在有实质内容时使用（如：任务完成通知、需要用户决策的阻塞、发现了重要信息）。' +
          '禁止发送无意义的"正在思考""稍等"等填充消息。',
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
    body: {
      model: env.textModel,
      messages,
      max_tokens: 2048,
      temperature: 0.5,
      thinking: { type: 'disabled' },
      tools,
      tool_choice: 'auto',
    },
  });

  const msg = raw.choices?.[0]?.message;
  return { content: msg?.content ?? null, tool_calls: msg?.tool_calls ?? [] };
}

// ── 心跳系统提示 ──────────────────────────────────────────────────────────────

function buildHeartbeatSystemPrompt(
  agentName: string,
  soul: string,
  longTermGoal: string,
  hasImCapability: boolean,
): string {
  const imSection = hasImCapability
    ? `- post_to_im：主动向 IM 发消息（仅在有实质内容时，克制使用）`
    : `- （当前无 IM 发送能力，UTLRA_OUTER_HEARTBEAT_THREAD_ID 未配置）`;

  const goalSection = longTermGoal
    ? `# 长期目标\n${longTermGoal}`
    : `# 长期目标\n（未设置。你可以在 DATA_ROOT/outer/goal.md 中定义长期目标来指导心跳行为。）`;

  return `你是 ${agentName}，现在进行定时自主规划（心跳模式）。

# 灵魂设定
${soul}

${goalSection}

## 心跳模式说明
你不是在回应某人，而是在进行定期的自我检查和规划。
对照长期目标，判断现在是否需要主动做什么。

## 可用工具
${imSection}
- set_goal：向内脑派发任务
- read_inner_status：查询内脑当前状态

## 行动原则
1. **先观察**：read_inner_status / list_inner_brains，看 async.is_async_waiting 与 next_wake_at
2. **有依据才行动**：对照长期目标，有明确理由才发消息或创建任务
3. **克制**：内脑已在等定时（is_async_waiting）或已完成（is_post_complete）时 **不要** set_goal
4. **每次最多**：发 1 条 IM 消息，创建 1 个内脑任务
5. **消息要简短**：发 IM 时 1-2 句话，有实质信息
6. **关联绩效目标**：推进绩效目标时把 goal_id 填入 performance_goal_id

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

  if (result.startsWith('已向内脑派发任务')) return 'success';
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

  // 读取记忆层（daily-log + tasks）注入心跳上下文
  const memStore = ctx.memoryStore;
  const memory   = memStore ? await memStore.readMemoryContext() : { dailyLog: '', tasks: '', hasAny: false };
  const memSection = memStore ? memStore.formatMemoryForLlm(memory) : '';

  const userContent = `当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}

## 内脑当前状态
${innerStatusText}
${memSection ? `\n${memSection}\n` : ''}
${performanceBlock ? `\n${performanceBlock}\n` : ''}
请对照长期目标，判断现在是否需要主动行动。`;

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

      // 热更新：每次 tick 重新读取 soul 和 long-term goal
      const soul = loadSoul(this.deps.dataRoot);
      const longTermGoal = loadOuterGoal(this.deps.dataRoot);
      const performanceBlock = await this.performanceEngine.reviewGoalsForHeartbeat(
        env,
        this.deps.memoryStore,
      );

      const ctx: OuterToolContext = {
        threadId: '',
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
      };

      this.deps.workspaceStore.ensureWorkspace(workspaceId);
      await runHeartbeat(
        env,
        ctx,
        soul,
        longTermGoal,
        this.deps.imClient,
        this.performanceEngine,
        this.config,
        performanceBlock,
      );
      console.log('[utlra][heartbeat] tick done');
    } catch (e) {
      console.error('[utlra][heartbeat] tick error', e);
    } finally {
      this.running = false;
    }
  }
}
