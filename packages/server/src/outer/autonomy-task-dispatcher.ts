/**
 * 自主任务 handler 注册表 + KPI 优先 / 性格概率闲聊 dispatch。
 */
import type { ChatIRChannel } from '@utlra/chat-ir';
import type { IdentityRegistry, LooseThreadStore } from '@utlra/chat-ir';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { llmRawChatCompletion } from '../llm/raw.js';
import { loadInboundConfigFromEnv } from './inbound-policy.js';
import { getGroupParticipationState, recordProactiveSpeak } from './participation-state.js';
import type { KpiRegistry, KpiRecord } from './kpi-registry.js';
import { selectKpiByMomentum } from './kpi-feedback.js';
import type { InnerBrainRegistry } from './inner-brain-registry.js';
import { executeOuterTool, type OuterToolContext } from './outer-tools.js';
import { loadSoul } from './soul.js';
import {
  loadAutonomyPolicy,
  markAutonomousAction,
} from './autonomy-policy-store.js';
import { loadPersonality } from './personality.js';
import { logAutonomyDispatch } from './autonomy-action-log.js';
import {
  evaluateKpiAutonomyDispatch,
  findLiveBurstForKpi,
} from './kpi-dispatch-guard.js';
import { isSetGoalDispatched } from './inner-brain-kpi-reuse.js';
import type { InnerBrainEngine } from '../workspace-kit/index.js';
import { buildKpiGoalPlannerContext } from './kpi-goal-context.js';
import type { OuterMemoryStore } from './outer-memory.js';
import { formatRecentThreadMessagesForLlm } from './thread-history.js';
import {
  isTaskOnCooldown,
  isTaskOverDailyLimit,
  recordTaskDispatch,
} from './autonomy-task-state.js';
import type {
  AgentPersonality,
  AutonomyDispatchResult,
  AutonomyPolicy,
  AutonomyTaskType,
  AutonomyVerdict,
  ResourceSnapshot,
} from './autonomy-types.js';

export interface AutonomyDispatchDeps {
  dataRoot: string;
  agentSid: string;
  workspaceId: string;
  defaultThreadId: string;
  registry: InnerBrainRegistry;
  kpiRegistry: KpiRegistry;
  imClient: ChatIRChannel | null;
  toolCtx: OuterToolContext;
  getLlmEnv: () => InnerLlmEnv | null;
  getEngine?: (workspaceId: string) => InnerBrainEngine;
  memoryStore?: OuterMemoryStore;
  loadThreads?: () => LooseThreadStore;
  identityRegistry?: IdentityRegistry;
  /**
   * 战略层 focusOrder（STRATEGY-PLANNING-LAYER.md §8/§10）：提供时 dispatcher 不再自由按 momentum 选，
   * 而是按 focusOrder ∩ active 顺序挑；交集为空 → 不派 KPI。由 pipeline 在 idle 时注入。
   */
  focusOrder?: string[];
  /** 战略模式：focusOrder 无可派 KPI 时跳过闲聊（避免战略/KPI 漂移时乱跑） */
  strategyMode?: boolean;
}

function taskConfig(policy: AutonomyPolicy, id: AutonomyTaskType) {
  return policy.taskTypes[id] ?? { enabled: false, cooldownMs: 0, maxPerDay: 0 };
}

/**
 * 选要推进的 active KPI：
 *   - 有 strategy.focusOrder（战略层启用）→ 按 focusOrder ∩ active 顺序挑第一个；交集空 → undefined（不派）。
 *   - 否则 → 多巴胺反馈调节按 momentum 选（取代固定 list[0]；见 STRATEGY-PLANNING-LAYER.md §16）。
 */
function pickActiveKpi(kpiRegistry: KpiRegistry, focusOrder?: string[]): KpiRecord | undefined {
  const active = kpiRegistry.list({ status: 'active' });
  if (focusOrder && focusOrder.length > 0) {
    for (const id of focusOrder) {
      const k = active.find((x) => x.kpiId === id);
      if (k) return k;
    }
    return undefined;
  }
  return selectKpiByMomentum(active);
}

function canSpawnInner(snapshot: ResourceSnapshot, _registry: InnerBrainRegistry, policy: AutonomyPolicy): boolean {
  const g = policy.hardGates;
  // 仅 RUNNING 占槽位；AWAITING 不计入。同 KPI 在途 burst 由 evaluateKpiAutonomyDispatch / isKpiSprintInProgress 串行把关。
  if (snapshot.innerBrains.running >= g.maxRunningInnerBrains) return false;
  return true;
}

function taskEligible(
  dataRoot: string,
  policy: AutonomyPolicy,
  taskType: AutonomyTaskType,
): { ok: boolean; reason: string } {
  const cfg = taskConfig(policy, taskType);
  if (!cfg.enabled) return { ok: false, reason: `${taskType}_disabled` };
  if (isTaskOnCooldown(dataRoot, taskType, cfg.cooldownMs)) {
    return { ok: false, reason: `${taskType}_cooldown` };
  }
  if (isTaskOverDailyLimit(dataRoot, taskType, cfg.maxPerDay)) {
    return { ok: false, reason: `${taskType}_max_per_day` };
  }
  return { ok: true, reason: 'ok' };
}

async function draftKpiGoal(
  env: InnerLlmEnv,
  deps: AutonomyDispatchDeps,
  snapshot: ResourceSnapshot,
): Promise<{ goal: string; kpiId: string } | null> {
  const kpi = pickActiveKpi(deps.kpiRegistry, deps.focusOrder);
  if (!kpi) return null;

  const soul = loadSoul(deps.dataRoot);
  const plannerContext = await buildKpiGoalPlannerContext({
    dataRoot: deps.dataRoot,
    kpi,
    kpiRegistry: deps.kpiRegistry,
    registry: deps.registry,
    snapshot,
    getEngine: deps.getEngine ?? deps.toolCtx.getEngine,
    memoryStore: deps.memoryStore ?? deps.toolCtx.memoryStore,
  });

  const { raw } = await llmRawChatCompletion<{
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  }>({
    provider: env.provider,
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    usageMeta: { source: 'autonomy', model: env.textModel, provider: env.provider },
    body: {
      model: env.textModel,
      temperature: 0.35,
      max_tokens: 1200,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'system',
          content:
            `${soul}\n\n你是外脑 KPI 规划器。根据下方完整上下文，设计**一条**可执行的内脑 goal。` +
            `只输出 goal 正文（Markdown），不要解释、不要 JSON、不要「好的」类前言。` +
            `必须避免与在途 burst 或最近已完成 burst 重复同一任务主题。`,
        },
        {
          role: 'user',
          content: plannerContext,
        },
      ],
    },
  });
  const goal = raw.choices?.[0]?.message?.content?.trim() ?? '';
  if (!goal) return null;
  return { goal, kpiId: kpi.kpiId };
}

async function executeKpiInnerGoal(
  deps: AutonomyDispatchDeps,
  snapshot: ResourceSnapshot,
): Promise<AutonomyDispatchResult> {
  const env = deps.getLlmEnv();
  if (!env) return { dispatched: false, reason: 'no_llm_env' };

  const draft = await draftKpiGoal(env, deps, snapshot);
  if (!draft) return { dispatched: false, reason: 'kpi_goal_draft_failed' };

  const toolOut = await executeOuterTool(
    'set_goal',
    JSON.stringify({
      goal: draft.goal,
      workspace_id: deps.workspaceId,
      kpi_id: draft.kpiId,
      origin_thread: deps.defaultThreadId.trim() || undefined,
    }),
    deps.toolCtx,
  );

  if (!isSetGoalDispatched(toolOut.output)) {
    return { dispatched: false, reason: 'set_goal_failed', detail: toolOut.output.slice(0, 200) };
  }

  return {
    dispatched: true,
    taskType: 'kpi_inner_goal',
    reason: 'kpi_inner_goal',
    detail: toolOut.output.slice(0, 200),
  };
}

function casualChatParticipationOk(threadId: string): { ok: boolean; reason: string } {
  const config = loadInboundConfigFromEnv();
  const state = getGroupParticipationState(threadId);
  const now = Date.now();
  if (now - state.lastProactiveAt < config.speakCooldownMs) {
    return { ok: false, reason: 'participation_cooldown' };
  }
  if (now - state.proactiveCountResetAt > 5 * 60 * 1000) {
    state.proactiveCount5min = 0;
    state.proactiveCountResetAt = now;
  }
  if (state.proactiveCount5min >= config.maxProactivePer5Min) {
    return { ok: false, reason: 'participation_max_5min' };
  }
  return { ok: true, reason: 'ok' };
}

async function draftCasualChatText(
  env: InnerLlmEnv,
  soul: string,
  agentName: string,
  kpiFocusLine: string,
  threadContext: string,
): Promise<string | null> {
  const { raw } = await llmRawChatCompletion<{
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  }>({
    provider: env.provider,
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    usageMeta: { source: 'autonomy', model: env.textModel, provider: env.provider },
    body: {
      model: env.textModel,
      temperature: 0.55,
      max_tokens: 160,
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'system',
          content:
            `${soul}\n\n你是 ${agentName}。外脑空闲时**可能**在 IM 自然接话。\n\n` +
            `## 边界（必须遵守）\n` +
            `- **只管自己的事**：${kpiFocusLine}\n` +
            `- 群聊在讨论**别的 agent** 的任务/内脑/小说/空投/VPS 等，且没 @你 → **只回复 SKIP**，不要插嘴、不要主动帮忙、不要当群管家。\n` +
            `- 不要替别人传文件/cookie、不要汇总他人进度、不要评论别人该怎么干。\n` +
            `- 只有人类 @你、或话题与**你的 KPI** 直接相关时，才考虑发言。\n\n` +
            `## 输出\n` +
            `能自然接话且与**你自己**相关：1-2 句，口语化，无 markdown 列表。\n` +
            `否则只回复一个词：SKIP`,
        },
        {
          role: 'user',
          content:
            `## 当前对话（最近消息）\n\n${threadContext}\n\n` +
            `若无必要接话（尤其是在聊别人的事），回复 SKIP。`,
        },
      ],
    },
  });
  const text = raw.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text || /^SKIP\b/i.test(text)) return null;
  return text;
}

async function executeCasualChat(
  deps: AutonomyDispatchDeps,
  personality: AgentPersonality,
  snapshot: ResourceSnapshot,
  policy: AutonomyPolicy,
): Promise<AutonomyDispatchResult> {
  if (!deps.imClient) return { dispatched: false, reason: 'no_im_client' };
  const threadId = deps.defaultThreadId.trim();
  if (!threadId) return { dispatched: false, reason: 'no_default_thread' };

  // 有 active KPI 时优先推进任务，不做无关闲聊
  const focusKpi = pickActiveKpi(deps.kpiRegistry, deps.focusOrder);
  if (focusKpi) {
    const activeKpi = focusKpi;
    const live = findLiveBurstForKpi(deps.registry, activeKpi.kpiId);
    if (live) {
      return { dispatched: false, reason: 'casual_chat_kpi_in_progress' };
    }
    if (canSpawnInner(snapshot, deps.registry, policy)) {
      return { dispatched: false, reason: 'casual_chat_defer_to_kpi' };
    }
  }

  const part = casualChatParticipationOk(threadId);
  if (!part.ok) return { dispatched: false, reason: part.reason };

  if (!deps.loadThreads || !deps.identityRegistry) {
    return { dispatched: false, reason: 'no_thread_store' };
  }

  const recent = formatRecentThreadMessagesForLlm(
    threadId,
    deps.loadThreads,
    deps.identityRegistry,
  );
  if (recent.messageCount === 0) {
    return { dispatched: false, reason: 'no_thread_context' };
  }
  if (!recent.hasHumanMessage) {
    return { dispatched: false, reason: 'no_human_in_thread' };
  }
  if (recent.lastSenderSid === deps.agentSid) {
    return { dispatched: false, reason: 'agent_spoke_last' };
  }

  if (Math.random() >= personality.idleChatProbability) {
    return { dispatched: false, reason: 'chat_probability_skip', detail: `p=${personality.idleChatProbability}` };
  }

  const env = deps.getLlmEnv();
  if (!env) return { dispatched: false, reason: 'no_llm_env' };

  const agentName = process.env['UTLRA_AGENT_NAME']?.trim() || deps.agentSid;
  const activeKpi = pickActiveKpi(deps.kpiRegistry, deps.focusOrder);
  const kpiFocusLine = activeKpi
    ? `当前 KPI：${activeKpi.description.slice(0, 120)}。闲聊不得耽误 KPI 推进。`
    : '无 active KPI 时也只接与自己工作相关的话，不管别人闲事。';

  const text = await draftCasualChatText(
    env,
    loadSoul(deps.dataRoot),
    agentName,
    kpiFocusLine,
    recent.text,
  );
  if (!text) return { dispatched: false, reason: 'chat_draft_failed' };

  try {
    await deps.imClient.postMessage(threadId, {
      sender_sid: deps.agentSid,
      text,
      parse_mentions: true,
    });
    recordProactiveSpeak(threadId);
    return { dispatched: true, taskType: 'casual_chat', reason: 'casual_chat', detail: text.slice(0, 120) };
  } catch (e) {
    return {
      dispatched: false,
      reason: 'post_failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function dispatchAutonomyTasks(
  deps: AutonomyDispatchDeps,
  snapshot: ResourceSnapshot,
  verdict: AutonomyVerdict,
): Promise<AutonomyDispatchResult> {
  if (verdict.level !== 'idle') {
    return { dispatched: false, reason: verdict.blockedByHardGate ?? 'busy' };
  }

  const policy = loadAutonomyPolicy(deps.dataRoot);
  const personality = loadPersonality(deps.dataRoot);

  // 1. KPI 优先（focusOrder 或 momentum 选；同 KPI 已有 RUNNING/AWAITING/BLOCKED 时绝不重复派发）
  const focusKpi = pickActiveKpi(deps.kpiRegistry, deps.focusOrder);
  if (focusKpi) {
    const activeKpi = focusKpi;
    const live = findLiveBurstForKpi(deps.registry, activeKpi.kpiId);
    if (live) {
      const result: AutonomyDispatchResult = {
        dispatched: false,
        reason: 'kpi_sprint_in_progress',
        detail: `${live.instanceId}:${live.status}`,
      };
      console.log(
        `[utlra][autonomy] hold: kpi sprint in flight live=${live.instanceId} status=${live.status}`,
      );
      logAutonomyDispatch(deps.dataRoot, snapshot, result);
      return result;
    }
  }

  if (focusKpi && canSpawnInner(snapshot, deps.registry, policy)) {
    const activeKpi = focusKpi;
    const kpiDecision = evaluateKpiAutonomyDispatch(
      deps.kpiRegistry,
      deps.registry,
      activeKpi.kpiId,
    );
    if (!kpiDecision.ok) {
      console.log(`[utlra][autonomy] skip kpi_inner_goal: ${kpiDecision.reason}`);
      const result: AutonomyDispatchResult = {
        dispatched: false,
        reason: kpiDecision.reason,
        detail: kpiDecision.liveInstanceId,
      };
      logAutonomyDispatch(deps.dataRoot, snapshot, result);
      return result;
    } else {
      const elig = taskEligible(deps.dataRoot, policy, 'kpi_inner_goal');
      if (elig.ok) {
        const result = await executeKpiInnerGoal(deps, snapshot);
        logAutonomyDispatch(deps.dataRoot, snapshot, result);
        if (result.dispatched) {
          recordTaskDispatch(deps.dataRoot, 'kpi_inner_goal');
          markAutonomousAction(deps.dataRoot);
        }
        return result;
      }
    }
  }

  // 战略模式：存在 active KPI 但 strategy 选了空 focus（交集空）→ 这是有意 hold，不掷闲聊（ADL §8/§10）。
  // 注意：无任何 active KPI 时没有可 hold 的目标，落到正常 idle 行为（闲聊），避免空跑期 agent 彻底静默。
  if (deps.strategyMode && !focusKpi && deps.kpiRegistry.list({ status: 'active' }).length > 0) {
    const result: AutonomyDispatchResult = { dispatched: false, reason: 'strategy_no_focus' };
    logAutonomyDispatch(deps.dataRoot, snapshot, result);
    return result;
  }

  // 2. 闲聊候选（无 KPI 或无法 spawn）
  const chatElig = taskEligible(deps.dataRoot, policy, 'casual_chat');
  if (!chatElig.ok) {
    const result: AutonomyDispatchResult = { dispatched: false, reason: chatElig.reason };
    logAutonomyDispatch(deps.dataRoot, snapshot, result);
    return result;
  }

  const result = await executeCasualChat(deps, personality, snapshot, policy);
  logAutonomyDispatch(deps.dataRoot, snapshot, result);
  if (result.dispatched) {
    recordTaskDispatch(deps.dataRoot, 'casual_chat');
    markAutonomousAction(deps.dataRoot);
  }
  return result;
}
